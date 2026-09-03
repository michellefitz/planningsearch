/**
 * Area watches: "tell me about new planning activity within N metres of this
 * point". Detection is a daily sweep of the baked bundle inside the
 * check-updates cron — an application (council or ACP direct case) or a
 * commencement notice is "new" when its date falls inside the recency window
 * and the watch hasn't alerted on it before.
 *
 * The recency window exists because the national feed lags reality by weeks
 * (Kildare by months): an application can appear in the bundle long after its
 * received_date, so "received since the last cron run" would miss most of
 * them, while "anything not yet alerted" would need every historical key
 * stored per watch. Recent-and-not-yet-alerted needs neither. Watches are
 * seeded at creation so pre-existing recent activity never alerts.
 */

import { sql } from "./db.mjs";

export const WATCH_WINDOW_DAYS = 60;
export const MIN_RADIUS_M = 100;
// 10 km covers the rural case — a townland watcher's "anywhere near me".
export const MAX_RADIUS_M = 10000;
export const MAX_WATCHES_PER_USER = 10;

/**
 * What a watch can alert on.
 *
 * The register carries a date for each of these, so detection is the same
 * cheap comparison in every case. The strings are the ones already written
 * into area_watch_alerted — "application" and "commencement" predate the
 * choice being offered, and renaming them would make every previously alerted
 * row stop matching and re-alert the lot.
 *
 * Not offered, and worth saying why: a further-information request is a step
 * in an application rather than an event a neighbour acts on, and it fires on
 * files that are already being watched under "application". The observation
 * deadline is a better candidate than any of these — it is the one date
 * someone can still act on — but it is a countdown rather than a thing that
 * happened, so it belongs to a reminder, not to this sweep.
 */
export const WATCH_KINDS = Object.freeze({
  application: {
    label: "New applications",
    hint: "Someone applies for permission inside the area.",
    dateField: "received_date",
  },
  decision: {
    label: "Decisions",
    hint: "The council grants or refuses — a refusal nearby is the precedent that matters most.",
    dateField: "decision_date",
  },
  appeal: {
    label: "Appeals",
    hint: "A decision inside the area is appealed to An Coimisiún Pleanála.",
    dateField: "appeal_lodged_date",
  },
  commencement: {
    label: "Work starting on site",
    hint: "A commencement notice is filed — building is about to begin.",
    dateField: "commencement_date",
  },
});

export const WATCH_KIND_IDS = Object.freeze(Object.keys(WATCH_KINDS));

/**
 * What a watch created before the choice existed was already alerting on, and
 * so what it must keep alerting on. Changing someone's alerts silently, in
 * either direction, is worse than the missing feature was.
 */
export const DEFAULT_WATCH_KINDS = Object.freeze(["application", "commencement"]);

/** The kinds a request asked for, or null when it named none we recognise. */
export function normaliseWatchKinds(input) {
  if (!Array.isArray(input)) return null;
  const seen = new Set();
  for (const raw of input) {
    const k = String(raw ?? "").trim();
    if (WATCH_KIND_IDS.includes(k)) seen.add(k);
  }
  if (!seen.size) return null;
  // Stable order, so the UI and the digest read the same way every time.
  return WATCH_KIND_IDS.filter((k) => seen.has(k));
}

/** Mirrors scripts/migrate-accounts.mjs — the script needs DATABASE_URL,
 *  which only production has, so the schema also applies itself lazily. */
let schemaReady = null;
export function ensureWatchSchema() {
  schemaReady ??= (async () => {
    await sql(`create table if not exists area_watches (
      id bigint generated always as identity primary key,
      user_id bigint not null references users(id) on delete cascade,
      name text not null,
      lat double precision not null,
      lng double precision not null,
      radius_m integer not null,
      alerts_enabled boolean not null default true,
      created_at timestamptz not null default now()
    )`);
    // Null rather than a default: a row written before the choice existed must
    // keep exactly the alerts it already had, and null is what says so.
    await sql(`alter table area_watches add column if not exists kinds text[]`);
    await sql(`create table if not exists area_watch_alerted (
      watch_id bigint not null references area_watches(id) on delete cascade,
      authority_id text not null,
      planning_reference text not null,
      kind text not null,
      alerted_at timestamptz not null default now(),
      primary key (watch_id, authority_id, planning_reference, kind)
    )`);
  })();
  return schemaReady;
}

function haversineM(aLat, aLng, bLat, bLng) {
  const R = 6371000;
  const dLat = ((bLat - aLat) * Math.PI) / 180;
  const dLng = ((bLng - aLng) * Math.PI) / 180;
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((aLat * Math.PI) / 180) * Math.cos((bLat * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

/**
 * Everything inside the watch circle with recent activity, as
 * `{ app, kinds }` — kinds ⊆ WATCH_KIND_IDS, narrowed to the ones this watch
 * asked for. `sinceIso` is the YYYY-MM-DD floor of the recency window.
 */
export function findWatchHits(applications, watch, sinceIso) {
  const hits = [];
  // Cheap bbox pre-filter: 1° latitude ≈ 111.32 km; longitude shrinks by
  // cos(lat). Keeps the haversine off ~99% of the register.
  const dLat = watch.radius_m / 111_320;
  const dLng = watch.radius_m / (111_320 * Math.cos((watch.lat * Math.PI) / 180));
  // A watch with no stored choice predates the feature and keeps what it had.
  const wanted = normaliseWatchKinds(watch.kinds) ?? DEFAULT_WATCH_KINDS;
  for (const app of applications) {
    if (app.lat == null || app.lng == null) continue;
    if (Math.abs(app.lat - watch.lat) > dLat || Math.abs(app.lng - watch.lng) > dLng) continue;
    const kinds = wanted.filter((k) => {
      const date = app[WATCH_KINDS[k].dateField];
      return Boolean(date) && date >= sinceIso;
    });
    if (!kinds.length) continue;
    // Haversine last: it is the expensive test and most rows never reach it.
    if (haversineM(watch.lat, watch.lng, app.lat, app.lng) > watch.radius_m) continue;
    hits.push({ app, kinds });
  }
  return hits;
}

export function watchWindowStart(now = new Date()) {
  return new Date(now.getTime() - WATCH_WINDOW_DAYS * 86400_000).toISOString().slice(0, 10);
}

/**
 * When the thing we are alerting about actually happened.
 *
 * Not the same as when we noticed: a commencement notice filed in March can
 * reach the register in September, and an email that only says "work has
 * commenced" invites the reader to assume it started today.
 */
export function watchHitDate(app, kind) {
  if (kind === "commencement") return app.commencement_date ?? null;
  if (kind === "decision") return app.decision_date ?? null;
  if (kind === "appeal") return app.appeal_lodged_date ?? app.appeal_decision_date ?? null;
  return app.received_date ?? null;
}

/** One human line per hit for the digest email. */
export function watchHitSummary(app, kind) {
  if (kind === "commencement") return "Work has commenced on site (commencement notice filed)";
  const units = app.num_residential_units;
  const size = units && units >= 10 ? ` (${units} homes)` : "";
  if (kind === "decision") {
    // The council's own word for it, so a grant and a refusal never read the
    // same — this is the line someone scans the email for.
    const outcome = String(app.decision ?? "").trim();
    return outcome ? `Decided — ${outcome}${size}` : `A decision has issued${size}`;
  }
  if (kind === "appeal") {
    const ref = app.appeal_reference ? ` (${app.appeal_reference})` : "";
    return `Appealed to An Coimisiún Pleanála${ref}`;
  }
  return app.authority_id === "acp"
    ? `New case lodged directly with An Coimisiún Pleanála${size}`
    : `New planning application${size}`;
}
