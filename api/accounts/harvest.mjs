/**
 * Nightly agile-portal harvest: persist per-application detail (full
 * description, applicant/agent, case officer, Eircode, live status/decision)
 * for the four agile councils into Neon, so the build-time export
 * (server/src/export-json.ts) can bake it into the data bundle. Runs inside
 * /api/cron/refresh-data before the deploy hook fires, time-boxed well under
 * the function's 300 s maxDuration.
 */
import { sql } from "./db.mjs";

const AGILE = new Set(["dublin-city", "fingal", "dlr", "south-dublin"]);
// Bundle statuses that can still change on the portal — keep re-harvesting.
const LIVE_STATUSES = new Set(["pending", "further_info", "incomplete", "appealed", "unknown"]);
const TIME_BUDGET_MS = 200_000;
const RETRY_FAILED_AFTER_MS = 90 * 86_400_000;
const CONCURRENCY = 3;
const REQUEST_DELAY_MS = 150;

// Tables created lazily (same pattern as api/preplan/routes.mjs) because
// sensitive env vars aren't pullable locally to run the migration script;
// scripts/migrate-accounts.mjs carries the same statements.
let schemaReady = null;
function ensureSchema() {
  schemaReady ??= (async () => {
    await sql(`create table if not exists agile_enrichment (
      authority_id text not null,
      planning_reference text not null,
      agile_id integer,
      full_description text,
      applicant_name text,
      agent_name text,
      officer_name text,
      eircode text,
      application_type text,
      live_status text,
      live_decision text,
      resolve_failed boolean not null default false,
      fetched_at timestamptz not null default now(),
      primary key (authority_id, planning_reference)
    )`);
    await sql(
      `alter table agile_enrichment add column if not exists application_type text`
    );
    await sql(
      `create index if not exists agile_enrichment_fetched_idx on agile_enrichment (fetched_at)`
    );
  })().catch((err) => {
    schemaReady = null;
    throw err;
  });
  return schemaReady;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Priority order: (a) never-harvested apps, newest received first — newest
 * data is most valuable, and very old refs predate each council's agile
 * migration and simply won't resolve; (b) already-harvested apps that are not
 * yet decided, stalest fetch first (live apps change); (c) failed resolutions,
 * retried only once ~90 days stale.
 */
export function buildHarvestQueue(apps, rows, now = Date.now()) {
  const byKey = new Map(rows.map((r) => [`${r.authority_id}|${r.planning_reference}`, r]));
  const fresh = [];
  const live = [];
  const retries = [];
  for (const app of apps) {
    const row = byKey.get(`${app.authority_id}|${app.planning_reference}`);
    if (!row) {
      fresh.push({ app, agile_id: null });
    } else if (row.resolve_failed) {
      if (now - Date.parse(row.fetched_at) > RETRY_FAILED_AFTER_MS)
        retries.push({ app, agile_id: row.agile_id ?? null });
    } else if (LIVE_STATUSES.has(String(app.status ?? "unknown"))) {
      live.push({ app, agile_id: row.agile_id ?? null, fetched_at: row.fetched_at });
    }
  }
  fresh.sort((a, b) =>
    String(b.app.received_date ?? "").localeCompare(String(a.app.received_date ?? ""))
  );
  live.sort((a, b) => String(a.fetched_at ?? "").localeCompare(String(b.fetched_at ?? "")));
  return [...fresh, ...live, ...retries];
}

async function harvestOne(ctx, item) {
  const { app } = item;
  const id = item.agile_id ?? (await ctx.resolveAgileId(app));
  if (!id) {
    // Mark so it isn't retried nightly (pre-migration refs never resolve).
    await sql(
      `insert into agile_enrichment (authority_id, planning_reference, resolve_failed)
       values ($1, $2, true)
       on conflict (authority_id, planning_reference)
       do update set resolve_failed = true, fetched_at = now()`,
      [app.authority_id, app.planning_reference]
    );
    return "resolve_failed";
  }
  const d = await ctx.fetchAgileDetailById(app.authority_id, id);
  if (!d) return "skipped"; // portal hiccup — row untouched, retried next night
  await sql(
    `insert into agile_enrichment
       (authority_id, planning_reference, agile_id, full_description, applicant_name,
        agent_name, officer_name, eircode, application_type, live_status, live_decision, resolve_failed)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, false)
     on conflict (authority_id, planning_reference) do update set
       agile_id = excluded.agile_id,
       full_description = excluded.full_description,
       applicant_name = excluded.applicant_name,
       agent_name = excluded.agent_name,
       officer_name = excluded.officer_name,
       eircode = excluded.eircode,
       application_type = excluded.application_type,
       live_status = excluded.live_status,
       live_decision = excluded.live_decision,
       resolve_failed = false,
       fetched_at = now()`,
    [
      app.authority_id,
      app.planning_reference,
      Number(id),
      d.description,
      d.applicant,
      d.agent,
      d.officer,
      d.eircode,
      d.application_type,
      d.status,
      d.decision,
    ]
  );
  return "harvested";
}

export async function runAgileHarvest(ctx) {
  const started = Date.now();
  await ensureSchema();
  const rows = await sql(
    `select authority_id, planning_reference, agile_id, resolve_failed, fetched_at
     from agile_enrichment`
  );
  const apps = ctx.applications.filter((a) => AGILE.has(a.authority_id));
  const queue = buildHarvestQueue(apps, rows);
  let harvested = 0;
  let resolveFailures = 0;
  const workers = Array.from({ length: CONCURRENCY }, async () => {
    while (queue.length && Date.now() - started < TIME_BUDGET_MS) {
      const item = queue.shift();
      try {
        const outcome = await harvestOne(ctx, item);
        if (outcome === "harvested") harvested++;
        else if (outcome === "resolve_failed") resolveFailures++;
      } catch (err) {
        console.error("harvest: skipped", item.app.authority_id, item.app.planning_reference, err);
      }
      await sleep(REQUEST_DELAY_MS);
    }
  });
  await Promise.all(workers);
  return { harvested, resolve_failures: resolveFailures, remaining_estimate: queue.length };
}
