/**
 * Durable cache for everything a model derives from a decided application.
 *
 * The in-process Maps this sits behind live and die with a serverless
 * instance, so before this the same popular application was re-summarised on
 * every cold start — cost scaled with page views rather than with the number
 * of applications. A decision never changes once made, so these answers are
 * permanently reusable.
 *
 * Keyed by (authority_id, planning_reference), NOT by the bundle's `id`:
 * ids are positional (`id: i + 1` in export-json.ts) and shift whenever the
 * register grows, so an id-keyed row would silently start describing a
 * different property after a nightly rebuild.
 *
 * Reuses the Neon connection the accounts feature already has — no new
 * service, no new credentials. Every failure is swallowed: a cache that is
 * unreachable must cost a model call, never a broken page.
 */
import { sql } from "../_accounts/db.mjs";

/** Kinds stored here. Each maps to one prompt's output for one application. */
export const AI_CACHE_KINDS = Object.freeze({
  REFUSAL: "refusal_summary",
  HIGHLIGHTS: "condition_highlights",
  APPEAL: "appeal_summary",
  DECISION: "decision_extract",
});

let schemaReady = null;
function ensureSchema() {
  // Created lazily, like api/_accounts/harvest.mjs — the migration script
  // carries the same statement for anyone who can run it directly.
  schemaReady ??= sql(`create table if not exists ai_cache (
    kind text not null,
    authority_id text not null,
    planning_reference text not null,
    payload jsonb not null,
    model text not null default 'claude-haiku-4-5',
    created_at timestamptz not null default now(),
    primary key (kind, authority_id, planning_reference)
  )`).catch((err) => {
    schemaReady = null;
    throw err;
  });
  return schemaReady;
}

const memo = new Map();
const memoKey = (kind, authorityId, reference) => `${kind}|${authorityId}|${reference}`;

/**
 * The stored answer, or undefined when there isn't one.
 *
 * `null` is a legitimate stored payload — "we read this and there was nothing
 * to say" — so callers must distinguish it from undefined, or an empty result
 * gets regenerated on every view.
 */
export async function aiCacheGet(kind, authorityId, reference) {
  if (!authorityId || !reference) return undefined;
  const k = memoKey(kind, authorityId, reference);
  if (memo.has(k)) return memo.get(k);
  if (!process.env.DATABASE_URL) return undefined;
  try {
    await ensureSchema();
    const rows = await sql(
      `select payload from ai_cache where kind = $1 and authority_id = $2 and planning_reference = $3`,
      [kind, authorityId, reference]
    );
    if (!rows.length) return undefined;
    const payload = rows[0].payload;
    memo.set(k, payload);
    return payload;
  } catch {
    return undefined;
  }
}

export async function aiCachePut(kind, authorityId, reference, payload) {
  if (!authorityId || !reference) return;
  memo.set(memoKey(kind, authorityId, reference), payload);
  if (!process.env.DATABASE_URL) return;
  try {
    await ensureSchema();
    await sql(
      `insert into ai_cache (kind, authority_id, planning_reference, payload)
       values ($1, $2, $3, $4::jsonb)
       on conflict (kind, authority_id, planning_reference)
       do update set payload = excluded.payload, created_at = now()`,
      [kind, authorityId, reference, JSON.stringify(payload ?? null)]
    );
  } catch {
    // A write that doesn't land costs one repeated model call, nothing more.
  }
}

/**
 * Read-through wrapper: the shape every call site wants.
 *
 * `generate` runs only on a miss. A null/undefined result is NOT stored — a
 * timeout or an unreachable council portal must retry on the next view rather
 * than be remembered as "nothing here".
 */
export async function aiCached(kind, authorityId, reference, generate) {
  const hit = await aiCacheGet(kind, authorityId, reference);
  if (hit !== undefined) return hit;
  const fresh = await generate();
  if (fresh !== null && fresh !== undefined) {
    await aiCachePut(kind, authorityId, reference, fresh);
  }
  return fresh;
}

/** Test seam — the memo would otherwise leak between cases. */
export function _resetAiCacheMemo() {
  memo.clear();
}
