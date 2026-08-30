/**
 * Backfill description summaries by fetching unique descriptions from
 * the production API, checking which ones are missing from Neon, and
 * generating summaries for the gaps.
 *
 * Reads DATABASE_URL and ANTHROPIC_API_KEY from the environment (or .env).
 *
 *   DATABASE_URL=… ANTHROPIC_API_KEY=… node scripts/summaries/backfill-from-api.mjs [--limit N] [--concurrency N]
 */
import { createHash } from "node:crypto";
import { sql } from "../../api/_accounts/db.mjs";
import {
  DESCRIPTION_SUMMARY_PROMPT,
  descriptionKey,
  descriptionUserMsg,
} from "../../api/_ai/descriptions.mjs";

// Overridable so this can be pointed at a preview deployment or a local
// server; the default follows the production domain.
const API_BASE = process.env.PLANVIEW_API_BASE ?? "https://planningsearch.vercel.app";
const MODEL = "claude-haiku-4-5-20251001";
const PRICE_IN = 1.0;
const PRICE_OUT = 5.0;

const args = process.argv.slice(2);
const flag = (name, fallback) =>
  args.includes(name) ? args[args.indexOf(name) + 1] : fallback;
const limit = Number(flag("--limit", Infinity));
const CONCURRENCY = Number(flag("--concurrency", 12));

const KEY = process.env.ANTHROPIC_API_KEY;
if (!KEY) {
  console.error("ANTHROPIC_API_KEY not set");
  process.exit(1);
}

const LEAK_RE =
  /\b(?:I (?:don'?t|do not|cannot|can'?t|couldn'?t|am unable|'?m unable|'?m sorry)|as an AI|could you (?:provide|clarify|share)|please provide|not enough (?:info|information|detail)|appears? (?:incomplete|to be incomplete)|the (?:description|text) (?:appears|seems|is) |would you like|unable to (?:summari|determine|tell))/i;

function usableSummary(text) {
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

async function fetchPage(page) {
  const url = `${API_BASE}/api/search?q=&limit=200&page=${page}`;
  for (let retry = 0; retry < 3; retry++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
      if (res.ok) return await res.json();
      if (res.status >= 500) {
        await new Promise((r) => setTimeout(r, 2000 * (retry + 1)));
        continue;
      }
      return null;
    } catch {
      await new Promise((r) => setTimeout(r, 2000 * (retry + 1)));
    }
  }
  return null;
}

async function fetchAllDescriptions() {
  console.log("Fetching application count from production API…");
  const first = await fetchPage(1);
  if (!first) { console.error("Could not reach API"); process.exit(1); }
  const total = first.total ?? 0;
  const totalPages = Math.ceil(total / 200);
  console.log(`${total.toLocaleString()} applications across ${totalPages.toLocaleString()} pages.\n`);

  const descriptions = new Map();
  let fetched = 0;

  function collectApps(data) {
    const apps = data?.results ?? [];
    for (const a of apps) {
      if (!a.description) continue;
      const key = descriptionKey(a.description);
      if (key && !descriptions.has(key)) {
        descriptions.set(key, {
          description: a.description,
          applicationType: a.application_type ?? null,
        });
      }
    }
    fetched += apps.length;
  }

  collectApps(first);

  const FETCH_CONCURRENCY = 8;
  let nextPage = 2;
  async function fetchWorker() {
    while (nextPage <= totalPages) {
      const page = nextPage++;
      const data = await fetchPage(page);
      if (data) collectApps(data);
      if (page % 200 === 0) {
        process.stdout.write(
          `  Page ${page}/${totalPages}: ${fetched.toLocaleString()} apps, ` +
          `${descriptions.size.toLocaleString()} unique descriptions\n`
        );
      }
    }
  }

  await Promise.all(Array.from({ length: FETCH_CONCURRENCY }, fetchWorker));
  console.log(`Fetched ${fetched.toLocaleString()} applications, ${descriptions.size.toLocaleString()} unique descriptions.\n`);
  return descriptions;
}

// Main
console.log("Checking existing summaries in Neon…");
const existing = await sql("select description_hash from description_summaries");
const have = new Set(existing.map((r) => r.description_hash));
console.log(`${have.size.toLocaleString()} summaries already in Neon.\n`);

const descriptions = await fetchAllDescriptions();

const queue = [...descriptions.entries()]
  .filter(([hash]) => !have.has(hash))
  .slice(0, limit);

console.log(`${queue.length.toLocaleString()} descriptions need summaries.\n`);
if (!queue.length) {
  console.log("Nothing to do — all descriptions are covered.");
  process.exit(0);
}

let done = 0;
let rejected = 0;
let written = 0;
const started = Date.now();
const BATCH_SIZE = 50;
let batch = [];

async function flushBatch() {
  if (batch.length === 0) return;
  const values = batch
    .map((_, i) => `($${i * 3 + 1}, $${i * 3 + 2}, $${i * 3 + 3})`)
    .join(",");
  const params = batch.flatMap((r) => [r.hash, r.summary, MODEL]);
  await sql(
    `insert into description_summaries (description_hash, summary, model) values ${values}
     on conflict (description_hash) do nothing`,
    params
  );
  batch = [];
}

async function worker() {
  while (queue.length) {
    const [hash, { description, applicationType }] = queue.shift();
    const summary = await summarise(description, applicationType);
    done++;
    if (summary) {
      batch.push({ hash, summary });
      written++;
      if (batch.length >= BATCH_SIZE) await flushBatch();
    } else {
      rejected++;
    }
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
await flushBatch();

const secs = (Date.now() - started) / 1000;
const cost = (inTokens / 1e6) * PRICE_IN + (outTokens / 1e6) * PRICE_OUT;
console.log(`\nDone: ${written.toLocaleString()} written, ${rejected.toLocaleString()} rejected.`);
console.log(
  `${secs.toFixed(0)}s at ${(done / secs).toFixed(1)}/s (${CONCURRENCY} concurrent, ${throttled} throttled).`
);
console.log(
  `Tokens: ${inTokens.toLocaleString()} in, ${outTokens.toLocaleString()} out → $${cost.toFixed(2)}.`
);
console.log(`\nTotal summaries now in Neon: ${(have.size + written).toLocaleString()}.`);
console.log("Trigger a redeploy to bake them into the next build.");
