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
export const MAX_RADIUS_M = 5000;
export const MAX_WATCHES_PER_USER = 10;

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
 * `{ app, kinds }` — kinds ⊆ {"application", "commencement"}. `sinceIso` is
 * the YYYY-MM-DD floor of the recency window.
 */
export function findWatchHits(applications, watch, sinceIso) {
  const hits = [];
  // Cheap bbox pre-filter: 1° latitude ≈ 111.32 km; longitude shrinks by
  // cos(lat). Keeps the haversine off ~99% of the register.
  const dLat = watch.radius_m / 111_320;
  const dLng = watch.radius_m / (111_320 * Math.cos((watch.lat * Math.PI) / 180));
  for (const app of applications) {
    if (app.lat == null || app.lng == null) continue;
    if (Math.abs(app.lat - watch.lat) > dLat || Math.abs(app.lng - watch.lng) > dLng) continue;
    const recentApp = app.received_date && app.received_date >= sinceIso;
    const recentCommencement = app.commencement_date && app.commencement_date >= sinceIso;
    if (!recentApp && !recentCommencement) continue;
    if (haversineM(watch.lat, watch.lng, app.lat, app.lng) > watch.radius_m) continue;
    const kinds = [];
    if (recentApp) kinds.push("application");
    if (recentCommencement) kinds.push("commencement");
    hits.push({ app, kinds });
  }
  return hits;
}

export function watchWindowStart(now = new Date()) {
  return new Date(now.getTime() - WATCH_WINDOW_DAYS * 86400_000).toISOString().slice(0, 10);
}

/** One human line per hit for the digest email. */
export function watchHitSummary(app, kind) {
  if (kind === "commencement") return "Work has commenced on site (commencement notice filed)";
  const units = app.num_residential_units;
  const size = units && units >= 10 ? ` (${units} homes)` : "";
  return app.authority_id === "acp"
    ? `New case lodged directly with An Coimisiún Pleanála${size}`
    : `New planning application${size}`;
}
