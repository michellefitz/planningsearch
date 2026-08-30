/**
 * Backfill description summaries, fetching full descriptions from the
 * Agile portal where the national feed truncates them.
 *
 * For Agile councils: checks agile_enrichment cache → fetches from portal
 * if missing → caches enrichment → generates summary from full text.
 * For ePlanning councils: uses the bundle description directly.
 *
 * Resumable: skips descriptions already in description_summaries (by hash)
 * and applications already in agile_enrichment (by reference).
 *
 *   DATABASE_URL=… ANTHROPIC_API_KEY=… node scripts/summaries/backfill-with-enrichment.mjs \
 *     [--concurrency N] [--limit N] [--enrich-only] [--skip-enrich]
 */
import { sql } from "../../api/_accounts/db.mjs";
import {
  DESCRIPTION_SUMMARY_PROMPT,
  descriptionKey,
  descriptionUserMsg,
} from "../../api/_ai/descriptions.mjs";

// Overridable so this can be pointed at a preview deployment or a local
// server; the default follows the production domain.
const API_BASE = process.env.PLANVIEW_API_BASE ?? "https://planningsearch.vercel.app";
const AGILE_API = "https://planningapi.agileapplications.ie/api";
const MODEL = "claude-haiku-4-5-20251001";
const PRICE_IN = 1.0;
const PRICE_OUT = 5.0;

const AGILE_CLIENTS = {
  "south-dublin": "SD",
  "dublin-city": "DCC",
  fingal: "FG",
  dlr: "DLR",
  "cork-city": "CORKCITY",
  "cork-county": "CORKCOCO",
  wexford: "WEXFORD",
};

const args = process.argv.slice(2);
const flag = (name, fallback) =>
  args.includes(name) ? args[args.indexOf(name) + 1] : fallback;
const CONCURRENCY = Number(flag("--concurrency", 20));
const LIMIT = Number(flag("--limit", Infinity));
const ENRICH_ONLY = args.includes("--enrich-only");
const SKIP_ENRICH = args.includes("--skip-enrich");

const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
if (!ANTHROPIC_KEY && !ENRICH_ONLY) {
  console.error("ANTHROPIC_API_KEY not set (use --enrich-only to skip summaries)");
  process.exit(1);
}

// ── Agile portal helpers ─────────────────────────────────────────────

const normRef = (s) => String(s ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
const REF_FIELDS = ["reference", "applicationReference", "caseReference", "formattedReference", "referenceNumber", "planningReference"];
const ID_FIELDS = ["id", "applicationId", "caseId", "applicationID"];

function fieldOf(r, fields) {
  for (const f of fields) {
    const v = r[f];
    if (v != null && String(v).trim()) return String(v).trim();
  }
  return null;
}

function coerceResults(json) {
  if (Array.isArray(json)) return json;
  if (json && typeof json === "object") {
    for (const k of ["results", "applications", "data", "items"])
      if (Array.isArray(json[k])) return json[k];
    for (const v of Object.values(json)) if (Array.isArray(v)) return v;
  }
  return [];
}

async function agileGet(url, client) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        Accept: "application/json",
        "x-client": client,
        "x-product": "CITIZENPORTAL",
        "x-service": "PA",
      },
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function resolveAgileId(client, sourceUrl, reference) {
  const fromUrl = sourceUrl?.match(/application-details\/(\d+)/i)?.[1];
  if (fromUrl) return Number(fromUrl);
  const url = `${AGILE_API}/application/search?query=${encodeURIComponent(reference)}`;
  const found = await agileGet(url, client);
  const results = coerceResults(found);
  const want = normRef(reference);
  let hit = results.find((r) => normRef(fieldOf(r, REF_FIELDS)) === want && fieldOf(r, ID_FIELDS));
  if (!hit && results.length === 1 && fieldOf(results[0], ID_FIELDS)) hit = results[0];
  return hit ? Number(fieldOf(hit, ID_FIELDS)) : null;
}

const DESCRIPTION_KEY_RE = /descript|proposal|development/i;
const NOT_DESCRIPTION_KEY_RE = /status|decision/i;
function pickDescription(d) {
  let best = null;
  for (const [key, value] of Object.entries(d)) {
    if (typeof value !== "string" || !DESCRIPTION_KEY_RE.test(key) || NOT_DESCRIPTION_KEY_RE.test(key)) continue;
    if (!best || value.length > best.length) best = value;
  }
  return best?.trim() || null;
}

function joinName(fore, sur, whole) {
  const parts = [fore, sur].map((v) => String(v ?? "").trim()).filter(Boolean);
  if (parts.length) return parts.join(" ");
  return String(whole ?? "").trim() || null;
}

function normaliseEircode(s) {
  if (!s) return null;
  const m = String(s).replace(/\s+/g, "").match(/^([A-Za-z]\d[\dWw])\s*([A-Za-z\d]{4})$/);
  return m ? `${m[1].toUpperCase()} ${m[2].toUpperCase()}` : null;
}

async function fetchEnrichment(authorityId, reference, sourceUrl) {
  const client = AGILE_CLIENTS[authorityId];
  if (!client) return null;
  const agileId = await resolveAgileId(client, sourceUrl, reference);
  if (!agileId) return { resolve_failed: true };
  const d = await agileGet(`${AGILE_API}/application/${agileId}`, client);
  if (!d || typeof d !== "object") return { resolve_failed: true };
  return {
    agile_id: agileId,
    full_description: pickDescription(d),
    applicant_name: joinName(d.applicantForename, d.applicantSurname, d.applicantName),
    agent_name: joinName(d.agentForename, d.agentSurname, d.agentName),
    officer_name: null,
    eircode: normaliseEircode(d.postcode),
    application_type: typeof d.applicationType === "string" ? d.applicationType.trim() || null : null,
    live_status: d.status ?? d.applicationStatus ?? null,
    live_decision: d.decision ?? d.decisionDescription ?? null,
    resolve_failed: false,
  };
}

// ── Haiku summary ────────────────────────────────────────────────────

const LEAK_RE =
  /\b(?:I (?:don'?t|do not|cannot|can'?t|couldn'?t|am unable|'?m unable|'?m sorry)|as an AI|could you (?:provide|clarify|share)|please provide|not enough (?:info|information|detail)|appears? (?:incomplete|to be incomplete)|the (?:description|text) (?:appears|seems|is) |would you like|unable to (?:summari|determine|tell))/i;

function usableSummary(text) {
  if (!text) return null;
  const t = String(text).trim();
  if (!t || /^insufficient[.!]?$/i.test(t) || LEAK_RE.test(t)) return null;
  return t;
}

let inTokens = 0, outTokens = 0, throttled = 0;

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
          "x-api-key": ANTHROPIC_KEY,
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

// ── Fetch all apps from production API ───────────────────────────────

async function fetchPage(page) {
  for (let retry = 0; retry < 3; retry++) {
    try {
      const res = await fetch(`${API_BASE}/api/search?q=&limit=200&page=${page}`, {
        signal: AbortSignal.timeout(30_000),
      });
      if (res.ok) return await res.json();
      if (res.status >= 500) await new Promise((r) => setTimeout(r, 2000 * (retry + 1)));
    } catch {
      await new Promise((r) => setTimeout(r, 2000 * (retry + 1)));
    }
  }
  return null;
}

async function fetchAllApps() {
  console.log("Fetching applications from production API…");
  const first = await fetchPage(1);
  if (!first) { console.error("Could not reach API"); process.exit(1); }
  const total = first.total ?? 0;
  const totalPages = Math.ceil(total / 200);
  console.log(`${total.toLocaleString()} applications, ${totalPages.toLocaleString()} pages.\n`);

  const apps = [];
  const seen = new Set();

  function collect(data) {
    for (const a of data?.results ?? []) {
      if (seen.has(a.id)) continue;
      seen.add(a.id);
      apps.push(a);
    }
  }

  collect(first);
  const FETCH_CONCURRENCY = 8;
  let nextPage = 2;
  async function worker() {
    while (nextPage <= totalPages) {
      const page = nextPage++;
      const data = await fetchPage(page);
      if (data) collect(data);
      if (page % 200 === 0) {
        process.stdout.write(`  Page ${page}/${totalPages}: ${apps.length.toLocaleString()} apps\n`);
      }
    }
  }
  await Promise.all(Array.from({ length: FETCH_CONCURRENCY }, worker));
  console.log(`Fetched ${apps.length.toLocaleString()} applications.\n`);
  return apps;
}

// ── Main ─────────────────────────────────────────────────────────────

// Load existing caches
console.log("Loading existing caches from Neon…");
const [existingSummaries, existingEnrichment] = await Promise.all([
  sql("select description_hash from description_summaries"),
  sql("select authority_id, planning_reference, full_description from agile_enrichment"),
]);
const summaryHashes = new Set(existingSummaries.map((r) => r.description_hash));
const enrichmentCache = new Map();
for (const r of existingEnrichment) {
  enrichmentCache.set(`${r.authority_id}|${r.planning_reference}`, r.full_description);
}
console.log(`  ${summaryHashes.size.toLocaleString()} summaries, ${enrichmentCache.size.toLocaleString()} enriched descriptions.\n`);

const allApps = await fetchAllApps();

// Build work queue: for each unique description (using best available text),
// generate a summary if we don't already have one.
const descMap = new Map(); // hash → { description, applicationType }
let enrichNeeded = []; // apps that need portal fetch
let enrichSkipped = 0, enrichCached = 0;

for (const a of allApps) {
  if (!a.description) continue;
  const isAgile = a.authority_id in AGILE_CLIENTS;

  if (isAgile && !SKIP_ENRICH) {
    const cacheKey = `${a.authority_id}|${a.planning_reference}`;
    const cached = enrichmentCache.get(cacheKey);
    if (cached) {
      enrichCached++;
      const best = cached.length > a.description.length ? cached : a.description;
      const key = descriptionKey(best);
      if (key && !descMap.has(key)) {
        descMap.set(key, { description: best, applicationType: a.application_type ?? null });
      }
    } else {
      enrichNeeded.push(a);
    }
  } else {
    const key = descriptionKey(a.description);
    if (key && !descMap.has(key)) {
      descMap.set(key, { description: a.description, applicationType: a.application_type ?? null });
    }
  }
}

console.log(`Agile enrichment: ${enrichCached.toLocaleString()} cached, ${enrichNeeded.length.toLocaleString()} need portal fetch.`);
if (enrichNeeded.length > LIMIT) enrichNeeded = enrichNeeded.slice(0, LIMIT);

// ── Phase 1: Enrich Agile apps ──────────────────────────────────────

if (enrichNeeded.length > 0 && !SKIP_ENRICH) {
  console.log(`\nPhase 1: Fetching ${enrichNeeded.length.toLocaleString()} enrichments from Agile portal…`);
  let enrichDone = 0, enrichFailed = 0, enrichOk = 0;
  const enrichStarted = Date.now();
  const ENRICH_CONCURRENCY = Math.min(CONCURRENCY, 10);
  const enrichQueue = [...enrichNeeded];

  async function enrichWorker() {
    while (enrichQueue.length) {
      const a = enrichQueue.shift();
      const result = await fetchEnrichment(a.authority_id, a.planning_reference, a.source_url);
      enrichDone++;

      if (result && !result.resolve_failed && result.full_description) {
        enrichOk++;
        // Cache in Neon
        try {
          await sql(
            `insert into agile_enrichment
             (authority_id, planning_reference, agile_id, full_description, applicant_name,
              agent_name, officer_name, eircode, application_type, live_status, live_decision, resolve_failed)
             values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
             on conflict (authority_id, planning_reference) do update set
               full_description = excluded.full_description,
               applicant_name = excluded.applicant_name,
               agent_name = excluded.agent_name,
               eircode = excluded.eircode,
               live_status = excluded.live_status,
               live_decision = excluded.live_decision,
               fetched_at = now()`,
            [a.authority_id, a.planning_reference, result.agile_id, result.full_description,
             result.applicant_name, result.agent_name, result.officer_name, result.eircode,
             result.application_type, result.live_status, result.live_decision, false]
          );
        } catch {}

        const best = result.full_description.length > (a.description?.length ?? 0)
          ? result.full_description : a.description;
        const key = descriptionKey(best);
        if (key && !descMap.has(key)) {
          descMap.set(key, { description: best, applicationType: a.application_type ?? null });
        }
      } else {
        enrichFailed++;
        // Still use the truncated description
        const key = descriptionKey(a.description);
        if (key && !descMap.has(key)) {
          descMap.set(key, { description: a.description, applicationType: a.application_type ?? null });
        }
        if (result?.resolve_failed) {
          try {
            await sql(
              `insert into agile_enrichment (authority_id, planning_reference, resolve_failed)
               values ($1, $2, true) on conflict (authority_id, planning_reference) do nothing`,
              [a.authority_id, a.planning_reference]
            );
          } catch {}
        }
      }

      if (enrichDone % 250 === 0) {
        const rate = enrichDone / ((Date.now() - enrichStarted) / 1000);
        const left = enrichQueue.length;
        process.stdout.write(
          `  ${enrichDone.toLocaleString()}/${enrichNeeded.length.toLocaleString()}  ` +
          `${rate.toFixed(1)}/s  ~${Math.round(left / rate / 60)}m left  ` +
          `${enrichOk} ok, ${enrichFailed} failed\n`
        );
      }
    }
  }

  await Promise.all(Array.from({ length: ENRICH_CONCURRENCY }, enrichWorker));
  const enrichSecs = (Date.now() - enrichStarted) / 1000;
  console.log(`Enrichment done: ${enrichOk.toLocaleString()} ok, ${enrichFailed.toLocaleString()} failed in ${enrichSecs.toFixed(0)}s.\n`);
}

if (ENRICH_ONLY) {
  console.log("--enrich-only: skipping summary generation.");
  process.exit(0);
}

// ── Phase 2: Generate summaries ──────────────────────────────────────

const summaryQueue = [...descMap.entries()]
  .filter(([hash]) => !summaryHashes.has(hash))
  .slice(0, LIMIT);

console.log(`Phase 2: ${summaryQueue.length.toLocaleString()} descriptions need summaries ` +
  `(${descMap.size.toLocaleString()} total unique, ${summaryHashes.size.toLocaleString()} already done).\n`);

if (!summaryQueue.length) {
  console.log("All descriptions already have summaries.");
  process.exit(0);
}

let done = 0, rejected = 0, written = 0;
const started = Date.now();
const BATCH_SIZE = 50;
let batch = [];

async function flushBatch() {
  if (!batch.length) return;
  const values = batch.map((_, i) => `($${i * 3 + 1}, $${i * 3 + 2}, $${i * 3 + 3})`).join(",");
  const params = batch.flatMap((r) => [r.hash, r.summary, MODEL]);
  try {
    await sql(
      `insert into description_summaries (description_hash, summary, model) values ${values}
       on conflict (description_hash) do update set summary = excluded.summary, created_at = now()`,
      params
    );
  } catch (e) {
    console.error("  Batch write failed:", e.message);
  }
  batch = [];
}

async function summaryWorker() {
  while (summaryQueue.length) {
    const [hash, { description, applicationType }] = summaryQueue.shift();
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
        `  ${done.toLocaleString()}/${(done + summaryQueue.length).toLocaleString()}  ` +
        `${rate.toFixed(1)}/s  ~${Math.round(summaryQueue.length / rate / 60)}m left  ` +
        `$${cost.toFixed(2)}  (${rejected} rejected, ${throttled} throttled)\n`
      );
    }
  }
}

await Promise.all(Array.from({ length: CONCURRENCY }, summaryWorker));
await flushBatch();

const secs = (Date.now() - started) / 1000;
const cost = (inTokens / 1e6) * PRICE_IN + (outTokens / 1e6) * PRICE_OUT;
console.log(`\nDone: ${written.toLocaleString()} written, ${rejected.toLocaleString()} rejected.`);
console.log(`${secs.toFixed(0)}s at ${(done / secs).toFixed(1)}/s (${CONCURRENCY} concurrent, ${throttled} throttled).`);
console.log(`Tokens: ${inTokens.toLocaleString()} in, ${outTokens.toLocaleString()} out → $${cost.toFixed(2)}.`);
console.log(`\nTrigger a redeploy to bake the new summaries into the bundle.`);
