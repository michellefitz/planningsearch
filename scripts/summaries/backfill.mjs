/**
 * Bulk-generate the description summaries that used to be produced one page
 * view at a time.
 *
 * Generation and storage are deliberately separate steps. Generation is slow
 * (hours for the full register) and needs only ANTHROPIC_API_KEY; storage
 * needs DATABASE_URL, which is not pullable everywhere. So this writes
 * append-only JSONL and `upload.mjs` pushes it into Neon.
 *
 * Resumable in both directions: a run reads back whatever the output file
 * already holds and skips it, and also skips anything already in Neon when
 * DATABASE_URL happens to be set. Interrupt it freely.
 *
 *   ANTHROPIC_API_KEY=… node scripts/summaries/backfill.mjs [--limit N] [--out FILE]
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  DESCRIPTION_SUMMARY_PROMPT,
  descriptionKey,
  descriptionUserMsg,
} from "../../api/_ai/descriptions.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const BUNDLE = process.env.PLANVIEW_BUNDLE ?? path.join(ROOT, "api/_data/planning.json");
const MODEL = "claude-haiku-4-5-20251001";
const CONCURRENCY = Number(process.env.SUMMARY_CONCURRENCY ?? 12);
/** Haiku 4.5, USD per million tokens. */
const PRICE_IN = 1.0;
const PRICE_OUT = 5.0;

const args = process.argv.slice(2);
const flag = (name, fallback) =>
  args.includes(name) ? args[args.indexOf(name) + 1] : fallback;
const limit = Number(flag("--limit", Infinity));
const OUT = flag("--out", path.join(ROOT, "api/_data/summaries.jsonl"));

const KEY = process.env.ANTHROPIC_API_KEY;
if (!KEY) {
  console.error("ANTHROPIC_API_KEY not set");
  process.exit(1);
}

const LEAK_RE =
  /\b(?:I (?:don'?t|do not|cannot|can'?t|couldn'?t|am unable|'?m unable|'?m sorry)|as an AI|could you (?:provide|clarify|share)|please provide|not enough (?:info|information|detail)|appears? (?:incomplete|to be incomplete)|the (?:description|text) (?:appears|seems|is) |would you like|unable to (?:summari|determine|tell))/i;

/** Same gate the live path uses: a refusal or a plea for more input is not a
 *  summary and must never reach the bundle. */
export function usableSummary(text) {
  if (!text) return null;
  const t = String(text).trim();
  if (!t || /^insufficient[.!]?$/i.test(t) || LEAK_RE.test(t)) return null;
  return t;
}

let inTokens = 0;
let outTokens = 0;
let throttled = 0;

async function summarise(description, applicationType) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30_000);
    try {
      const res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        signal: controller.signal,
        headers: {
          "Content-Type": "application/json",
          "x-api-key": KEY,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: MODEL,
          max_tokens: 120,
          system: DESCRIPTION_SUMMARY_PROMPT,
          messages: [{ role: "user", content: descriptionUserMsg(description, applicationType) }],
        }),
      });
      if (res.status === 429 || res.status >= 500) {
        throttled++;
        const wait = Number(res.headers.get("retry-after")) * 1000 || 2000 * 2 ** attempt;
        await new Promise((r) => setTimeout(r, Math.min(wait, 30_000)));
        continue;
      }
      if (!res.ok) return null;
      const data = await res.json();
      inTokens += data.usage?.input_tokens ?? 0;
      outTokens += data.usage?.output_tokens ?? 0;
      return usableSummary(data.content?.find((b) => b.type === "text")?.text ?? null);
    } catch {
      await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
    } finally {
      clearTimeout(timer);
    }
  }
  return null;
}

// ---------------------------------------------------------------------------

console.log(`Reading ${BUNDLE} …`);
const bundle = JSON.parse(fs.readFileSync(BUNDLE, "utf8"));

/** One entry per distinct description; the type helps the model classify. */
const wanted = new Map();
for (const a of bundle.applications) {
  const key = descriptionKey(a.description);
  if (!key || wanted.has(key)) continue;
  wanted.set(key, { description: a.description, applicationType: a.application_type ?? null });
}
console.log(
  `${bundle.applications.length.toLocaleString()} applications, ` +
    `${wanted.size.toLocaleString()} distinct descriptions.`
);

const have = new Set();
if (fs.existsSync(OUT)) {
  for (const line of fs.readFileSync(OUT, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      have.add(JSON.parse(line).h);
    } catch {
      // A torn last line from an interrupted run — it just gets redone.
    }
  }
  console.log(`${have.size.toLocaleString()} already in ${path.basename(OUT)}.`);
}
if (process.env.DATABASE_URL) {
  try {
    const { sql } = await import("../../api/_accounts/db.mjs");
    const rows = await sql(`select description_hash from description_summaries`);
    for (const r of rows) have.add(r.description_hash);
    console.log(`${rows.length.toLocaleString()} already in Neon.`);
  } catch {
    console.log("Neon unreachable — going by the local file alone.");
  }
}

const queue = [...wanted.entries()].filter(([k]) => !have.has(k)).slice(0, limit);
console.log(`${queue.length.toLocaleString()} to generate.\n`);
if (!queue.length) process.exit(0);

fs.mkdirSync(path.dirname(OUT), { recursive: true });
const sink = fs.createWriteStream(OUT, { flags: "a" });
let done = 0;
let rejected = 0;
const started = Date.now();

async function worker() {
  while (queue.length) {
    const [hash, { description, applicationType }] = queue.shift();
    const summary = await summarise(description, applicationType);
    done++;
    if (summary) sink.write(JSON.stringify({ h: hash, s: summary }) + "\n");
    else rejected++;
    if (done % 250 === 0) {
      const rate = done / ((Date.now() - started) / 1000);
      const cost = (inTokens / 1e6) * PRICE_IN + (outTokens / 1e6) * PRICE_OUT;
      process.stdout.write(
        `  ${done.toLocaleString()}/${(done + queue.length).toLocaleString()}  ` +
          `${rate.toFixed(1)}/s  ~${Math.round(queue.length / rate / 60)}m left  ` +
          `$${cost.toFixed(2)}  (${rejected} rejected, ${throttled} throttled)\n`
      );
    }
  }
}
await Promise.all(Array.from({ length: CONCURRENCY }, worker));
await new Promise((r) => sink.end(r));

const secs = (Date.now() - started) / 1000;
const cost = (inTokens / 1e6) * PRICE_IN + (outTokens / 1e6) * PRICE_OUT;
console.log(`\nGenerated ${(done - rejected).toLocaleString()}, rejected ${rejected.toLocaleString()}.`);
console.log(`${secs.toFixed(0)}s at ${(done / secs).toFixed(1)}/s (${CONCURRENCY} concurrent, ${throttled} throttled).`);
console.log(`Tokens: ${inTokens.toLocaleString()} in, ${outTokens.toLocaleString()} out → $${cost.toFixed(2)}.`);
console.log(`Per summary: ${Math.round(inTokens / done)} in / ${Math.round(outTokens / done)} out, $${(cost / done).toFixed(5)}.`);
console.log(`\nWritten to ${OUT}. Load it with:\n  DATABASE_URL=… node scripts/summaries/upload.mjs`);
