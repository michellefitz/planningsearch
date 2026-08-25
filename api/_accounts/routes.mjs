import crypto from "node:crypto";
import { sql } from "./db.mjs";
import {
  clearSessionCookie, parseCookies, randomToken,
  SESSION_COOKIE, sessionCookie, sha256Hex,
  unsubscribeToken, verifyUnsubscribeToken,
} from "./tokens.mjs";
import { magicLinkEmail, sendEmail } from "./email.mjs";
import { diffSnapshots, fmtEventDate, normalizeStatus, snapshotFromBundleApp } from "./diff.mjs";
import { fetchLiveNationalSnapshot } from "./live.mjs";
import { fetchKildareLiveSnapshot } from "./kildare.mjs";
import { buildDigestEmail } from "./digest.mjs";
import { runAgileHarvest } from "./harvest.mjs";
import { topUpDescriptionSummaries } from "../_ai/topup.mjs";
import {
  ensureWatchSchema, findWatchHits, MAX_RADIUS_M, MAX_WATCHES_PER_USER,
  MIN_RADIUS_M, watchHitSummary, watchWindowStart,
  DEFAULT_WATCH_KINDS, normaliseWatchKinds,
} from "./watches.mjs";

const AGILE = new Set(["dublin-city", "fingal", "dlr", "south-dublin"]);

function verifyBearer(req, secret) {
  if (!secret) return false;
  const auth = req.headers.authorization ?? "";
  const expected = `Bearer ${secret}`;
  if (auth.length !== expected.length) return false;
  return crypto.timingSafeEqual(Buffer.from(auth), Buffer.from(expected));
}

const AUTH_RATE_WINDOW = 900_000;
const AUTH_RATE_MAX = 5;
const authRateMap = new Map();
function authRateOk(ip) {
  const now = Date.now();
  let rec = authRateMap.get(ip);
  if (!rec || now - rec.start > AUTH_RATE_WINDOW) {
    rec = { start: now, count: 0 };
    authRateMap.set(ip, rec);
  }
  rec.count++;
  if (authRateMap.size > 10_000) {
    for (const [k, v] of authRateMap) {
      if (now - v.start > AUTH_RATE_WINDOW) authRateMap.delete(k);
    }
  }
  return rec.count <= AUTH_RATE_MAX;
}

export function isAccountRoute(route) {
  return (
    route.startsWith("/api/auth/") ||
    route === "/api/me" ||
    route === "/api/saves" || route.startsWith("/api/saves/") ||
    route === "/api/lists" || route.startsWith("/api/lists/") ||
    route === "/api/watches" || route.startsWith("/api/watches/") ||
    route === "/api/resolve" ||
    route === "/api/alerts/unsubscribe" ||
    route === "/api/cron/check-updates" ||
    route === "/api/cron/refresh-data"
  );
}

function sendPrivate(res, code, body) {
  res.statusCode = code;
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(body));
}

async function readJsonBody(req, maxBytes = 50_000) {
  const chunks = [];
  let total = 0;
  for await (const c of req) {
    total += c.length;
    if (total > maxBytes) return null;
    chunks.push(c);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    return null;
  }
}

export async function currentUser(req) {
  const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
  if (!token) return null;
  const rows = await sql(
    `select u.id, u.email from sessions s join users u on u.id = s.user_id
     where s.token_hash = $1 and s.expires_at > now()`,
    [sha256Hex(token)]
  );
  return rows[0] ?? null;
}

/**
 * Mirrors scripts/migrate-accounts.mjs, for the same reason ensureWatchSchema
 * does: the script needs DATABASE_URL, which only production has, so a column
 * added after the tables shipped has to apply itself.
 *
 * Deliberately not called from currentUser. That runs on every authenticated
 * request, and when `name` was read there before this existed, the missing
 * column threw, the session came back null, and signing in appeared to do
 * nothing at all — the sign-in form again, straight after a valid magic link.
 * The hot path stays on columns that have always been there.
 */
/** The account's name, or null — including when the column is not there yet,
 *  because a missing name must never cost anyone their session. */
async function loadUserName(userId) {
  try {
    await ensureUserSchema();
    const rows = await sql(`select name from users where id = $1`, [userId]);
    return rows[0]?.name ?? null;
  } catch (err) {
    console.error("name lookup failed", err);
    return null;
  }
}

let userSchemaReady = null;
export function ensureUserSchema() {
  userSchemaReady ??= sql(`alter table users add column if not exists name text`);
  return userSchemaReady;
}

async function seedSnapshot(authorityId, reference, ctx) {
  const existing = await sql(
    `select 1 from app_snapshots where authority_id = $1 and planning_reference = $2`,
    [authorityId, reference]
  );
  if (existing.length) return;
  const app = ctx.findApp(authorityId, reference);
  if (!app) return;
  await sql(
    `insert into app_snapshots (authority_id, planning_reference, snapshot)
     values ($1, $2, $3::jsonb) on conflict do nothing`,
    [authorityId, reference, JSON.stringify(snapshotFromBundleApp(app))]
  );
}

async function loadSaves(userId, ctx) {
  const saves = await sql(
    `select s.id, s.authority_id, s.planning_reference, s.alerts_enabled, s.events_seen_at, s.created_at,
            e.summary as latest_event_summary, e.detected_at as latest_event_at
     from saved_apps s
     left join lateral (
       select summary, detected_at from app_events
       where authority_id = s.authority_id and planning_reference = s.planning_reference
       order by detected_at desc limit 1
     ) e on true
     where s.user_id = $1 order by s.created_at desc`,
    [userId]
  );
  const updated = await sql(
    `select distinct s.id from saved_apps s
     join app_events e on e.authority_id = s.authority_id and e.planning_reference = s.planning_reference
     where s.user_id = $1 and e.detected_at > s.events_seen_at`,
    [userId]
  );
  const updatedIds = new Set(updated.map((r) => r.id));
  return saves.map((s) => {
    const app = ctx.findApp(s.authority_id, s.planning_reference);
    return { ...s, has_update: updatedIds.has(s.id), app: app ? ctx.appSummary(app) : null };
  });
}

async function loadLists(userId) {
  const lists = await sql(
    `select l.id, l.name, l.position,
            coalesce(bool_and(s.alerts_enabled), true) as alerts_enabled
     from lists l
     left join list_items li on li.list_id = l.id
     left join saved_apps s on s.id = li.saved_app_id
     where l.user_id = $1
     group by l.id, l.name, l.position
     order by l.position, l.id`,
    [userId]
  );
  const items = await sql(
    `select li.list_id, li.saved_app_id from list_items li
     join lists l on l.id = li.list_id where l.user_id = $1`,
    [userId]
  );
  return lists.map((l) => ({
    ...l,
    item_ids: items.filter((i) => i.list_id === l.id).map((i) => i.saved_app_id),
  }));
}

async function loadWatches(userId) {
  try {
    return await sql(
      `select id, name, lat, lng, radius_m, kinds, alerts_enabled, created_at
       from area_watches where user_id = $1 order by created_at desc`,
      [userId]
    );
  } catch {
    // Table not created yet (fresh database, no watch saved anywhere).
    return [];
  }
}

async function mapLimit(items, limit, fn) {
  const queue = [...items];
  const workers = Array.from({ length: Math.min(limit, queue.length) }, async () => {
    while (queue.length) await fn(queue.shift());
  });
  await Promise.all(workers);
}

export async function handleAccountRoute(req, res, route, url, ctx) {
  try {
    return await dispatch(req, res, route, url, ctx);
  } catch (err) {
    console.error("account route failed", route, err);
    return sendPrivate(res, 500, { error: "something went wrong" });
  }
}

async function dispatch(req, res, route, url, ctx) {
  const p = url.searchParams;

  if (route === "/api/auth/request-link") {
    if (req.method !== "POST") return sendPrivate(res, 405, { error: "POST only" });
    const ip = (req.headers["x-forwarded-for"] ?? "").split(",")[0].trim();
    if (!authRateOk(ip)) return sendPrivate(res, 200, { ok: true });
    const body = await readJsonBody(req);
    const email = String(body?.email ?? "").trim().toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email))
      return sendPrivate(res, 400, { error: "valid email required" });
    const live = await sql(
      `select count(*)::int as n from auth_tokens
       where email = $1 and expires_at > now() and used_at is null`,
      [email]
    );
    if ((live[0]?.n ?? 0) >= 3) return sendPrivate(res, 200, { ok: true });
    const token = randomToken();
    await sql(
      `insert into auth_tokens (token_hash, email, expires_at)
       values ($1, $2, now() + interval '15 minutes')`,
      [sha256Hex(token), email]
    );
    const origin = process.env.APP_ORIGIN;
    if (!origin) return sendPrivate(res, 500, { error: "something went wrong" });
    const link = `${origin}/api/auth/verify?token=${token}`;
    await sendEmail({ to: email, ...magicLinkEmail(link) });
    return sendPrivate(res, 200, { ok: true });
  }

  if (route === "/api/auth/verify") {
    const token = p.get("token") ?? "";
    if (!token) {
      res.statusCode = 302;
      res.setHeader("Location", "/#auth-expired");
      return res.end();
    }

    if (req.method === "POST") {
      const body = await readJsonBody(req);
      const postToken = String(body?.token ?? "");
      const rows = postToken
        ? await sql(
            `update auth_tokens set used_at = now()
             where token_hash = $1 and used_at is null and expires_at > now()
             returning email`,
            [sha256Hex(postToken)]
          )
        : [];
      if (!rows.length) return sendPrivate(res, 400, { error: "expired" });
      const users = await sql(
        `insert into users (email) values ($1)
         on conflict (email) do update set email = excluded.email returning id`,
        [rows[0].email]
      );
      const sess = randomToken();
      await sql(
        `insert into sessions (token_hash, user_id, expires_at)
         values ($1, $2, now() + interval '90 days')`,
        [sha256Hex(sess), users[0].id]
      );
      res.setHeader("Set-Cookie", sessionCookie(sess));
      return sendPrivate(res, 200, { ok: true });
    }

    const valid = await sql(
      `select 1 from auth_tokens
       where token_hash = $1 and used_at is null and expires_at > now()`,
      [sha256Hex(token)]
    );
    if (!valid.length) {
      res.statusCode = 302;
      res.setHeader("Location", "/#auth-expired");
      return res.end();
    }
    res.statusCode = 200;
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");
    return res.end(`<!doctype html>
<html><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>Sign in to PlanView</title></head>
<body style="font-family:Inter,system-ui,sans-serif;color:#1a1d21;max-width:400px;margin:80px auto;padding:0 16px;text-align:center;">
<h2 style="color:#17456e;">Sign in to PlanView</h2>
<p style="color:#5c6370;line-height:1.6;">Click below to complete sign-in.</p>
<button id="btn" style="background:#0b62d6;color:#fff;border:none;padding:12px 32px;border-radius:8px;font-size:16px;cursor:pointer;">Complete sign-in</button>
<p id="msg" style="color:#5c6370;display:none;"></p>
<script>
document.getElementById("btn").onclick = async function() {
  this.disabled = true;
  this.textContent = "Signing in…";
  try {
    const r = await fetch("/api/auth/verify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: ${JSON.stringify(token)} }),
      credentials: "same-origin",
    });
    if (r.ok) { window.location.href = "/#account"; return; }
    document.getElementById("msg").style.display = "";
    document.getElementById("msg").textContent = "This link has expired. Please request a new one.";
  } catch {
    document.getElementById("msg").style.display = "";
    document.getElementById("msg").textContent = "Something went wrong. Please try again.";
  }
  this.disabled = false;
  this.textContent = "Complete sign-in";
};
</script>
</body></html>`);
  }

  if (route === "/api/auth/logout") {
    if (req.method !== "POST") return sendPrivate(res, 405, { error: "POST only" });
    const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
    if (token) await sql(`delete from sessions where token_hash = $1`, [sha256Hex(token)]);
    res.setHeader("Set-Cookie", clearSessionCookie());
    return sendPrivate(res, 200, { ok: true });
  }

  if (route === "/api/resolve") {
    const app = ctx.findApp(p.get("authority") ?? "", p.get("reference") ?? "");
    return sendPrivate(res, app ? 200 : 404, app ? { id: app.id } : { error: "not found" });
  }

  if (route === "/api/alerts/unsubscribe") {
    // Reached from an email link, so no session: identity comes from the HMAC token.
    const userId = Number(p.get("u"));
    if (!Number.isInteger(userId) || !verifyUnsubscribeToken(userId, p.get("t") ?? "")) {
      res.statusCode = 400;
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      return res.end("<p>This unsubscribe link is invalid or has expired.</p>");
    }
    await sql(`update saved_apps set alerts_enabled = false where user_id = $1`, [userId]);
    // Area watches feed the same digest, so the same link silences them.
    try {
      await sql(`update area_watches set alerts_enabled = false where user_id = $1`, [userId]);
    } catch {
      // Table may not exist yet on a fresh database — nothing to silence.
    }
    res.statusCode = 200;
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");
    return res.end(`<!doctype html>
<html><body style="font-family:Inter,system-ui,sans-serif;color:#1a1d21;max-width:480px;margin:64px auto;padding:0 16px;">
<h2 style="color:#17456e;">Alerts turned off</h2>
<p style="color:#5c6370;line-height:1.6;">You won't get any more update emails from PlanView. Your saved applications are untouched — you can turn alerts back on any time from your <a href="/#account" style="color:#0b62d6;">PlanView account</a>.</p>
</body></html>`);
  }

  if (route === "/api/cron/check-updates") return handleCron(req, res, ctx);

  if (route === "/api/cron/refresh-data") {
    // Nightly: harvest agile-portal detail into Neon, then trigger a
    // production rebuild so the baked bundle re-exports (and merges the fresh
    // harvest). The hook deploys main as-is.
    const secret = process.env.CRON_SECRET;
    if (!verifyBearer(req, secret))
      return sendPrivate(res, 401, { error: "unauthorized" });
    const hook = process.env.DEPLOY_HOOK_URL;
    if (!hook) return sendPrivate(res, 500, { error: "DEPLOY_HOOK_URL not set" });
    let harvest;
    try {
      harvest = await runAgileHarvest(ctx);
    } catch (err) {
      // Harvest failure must never block the nightly rebuild.
      console.error("agile harvest failed", err);
      harvest = { error: String(err?.message ?? err) };
    }
    // Summarise the descriptions that arrived since the last build, so the
    // rebuild below bakes them in. Without this every new application would
    // fall back to the per-view model call the precompute exists to remove,
    // and the gap would widen every night.
    const summaries = await topUpDescriptionSummaries(ctx.applications ?? []);
    const r = await fetch(hook, { method: "POST" });
    return sendPrivate(res, r.ok ? 200 : 502, {
      triggered: r.ok,
      status: r.status,
      harvest,
      summaries,
    });
  }

  const user = await currentUser(req);

  // Method-guarded: PATCH is handled below, after the sign-in check. Without
  // the guard it would fall in here and quietly return the unchanged account.
  if (route === "/api/me" && req.method !== "PATCH") {
    if (!user) return sendPrivate(res, 200, { user: null, saves: [], lists: [], watches: [] });
    const [saves, lists, watches, name] = await Promise.all([
      loadSaves(user.id, ctx),
      loadLists(user.id),
      loadWatches(user.id),
      loadUserName(user.id),
    ]);
    return sendPrivate(res, 200, { user: { email: user.email, name }, saves, lists, watches });
  }

  if (!user) return sendPrivate(res, 401, { error: "sign in required" });

  // The account's own details. Only a name so far: it is what an alert email
  // can greet you by, and the one thing about you the register cannot supply.
  if (route === "/api/me" && req.method === "PATCH") {
    const body = await readJsonBody(req);
    if (body && "name" in body) {
      await ensureUserSchema();
      const raw = body.name == null ? "" : String(body.name).trim().slice(0, 80);
      await sql(`update users set name = $2 where id = $1`, [user.id, raw || null]);
      return sendPrivate(res, 200, { user: { email: user.email, name: raw || null } });
    }
    return sendPrivate(res, 400, { error: "nothing to update" });
  }

  if (route === "/api/watches" && req.method === "POST") {
    const body = await readJsonBody(req);
    const name = String(body?.name ?? "").trim().slice(0, 80);
    const lat = Number(body?.lat);
    const lng = Number(body?.lng);
    const radius = Math.round(Number(body?.radius_m));
    if (!name) return sendPrivate(res, 400, { error: "name required" });
    // Loose Ireland bounds — a watch on Null Island alerts on nothing forever.
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || lat < 51 || lat > 56 || lng < -11 || lng > -5)
      return sendPrivate(res, 400, { error: "location must be in Ireland" });
    if (!Number.isFinite(radius) || radius < MIN_RADIUS_M || radius > MAX_RADIUS_M)
      return sendPrivate(res, 400, { error: `radius must be ${MIN_RADIUS_M}-${MAX_RADIUS_M} m` });
    await ensureWatchSchema();
    const count = await sql(`select count(*)::int as n from area_watches where user_id = $1`, [user.id]);
    if ((count[0]?.n ?? 0) >= MAX_WATCHES_PER_USER)
      return sendPrivate(res, 400, { error: `limit of ${MAX_WATCHES_PER_USER} watched areas reached` });
    // A watch that alerts on nothing is a watch that will feel broken, so an
    // unrecognised or empty selection falls back to what the feature did
    // before it was a choice.
    const kinds = normaliseWatchKinds(body?.kinds) ?? [...DEFAULT_WATCH_KINDS];
    const rows = await sql(
      `insert into area_watches (user_id, name, lat, lng, radius_m, kinds)
       values ($1, $2, $3, $4, $5, $6)
       returning id, name, lat, lng, radius_m, kinds, alerts_enabled, created_at`,
      [user.id, name, lat, lng, radius, kinds]
    );
    const watch = rows[0];
    const hits = findWatchHits(ctx.applications, watch, watchWindowStart());
    const seedRows = hits.flatMap((h) =>
      h.kinds.map((kind) => [watch.id, h.app.authority_id, h.app.planning_reference, kind])
    );
    if (seedRows.length) {
      const vals = seedRows.map((_, i) => `($${i * 4 + 1}, $${i * 4 + 2}, $${i * 4 + 3}, $${i * 4 + 4})`).join(", ");
      await sql(
        `insert into area_watch_alerted (watch_id, authority_id, planning_reference, kind)
         values ${vals} on conflict do nothing`,
        seedRows.flat()
      );
    }
    return sendPrivate(res, 200, watch);
  }

  const watchMatch = route.match(/^\/api\/watches\/(\d+)$/);
  if (watchMatch) {
    const id = Number(watchMatch[1]);
    if (req.method === "DELETE") {
      await sql(`delete from area_watches where id = $1 and user_id = $2`, [id, user.id]);
      return sendPrivate(res, 200, { ok: true });
    }
    if (req.method === "PATCH") {
      const body = await readJsonBody(req);
      await ensureWatchSchema();
      if (typeof body?.alerts_enabled === "boolean")
        await sql(`update area_watches set alerts_enabled = $3 where id = $1 and user_id = $2`, [id, user.id, body.alerts_enabled]);
      if (body?.name !== undefined) {
        const next = String(body.name ?? "").trim().slice(0, 80);
        if (!next) return sendPrivate(res, 400, { error: "name required" });
        await sql(`update area_watches set name = $3 where id = $1 and user_id = $2`, [id, user.id, next]);
      }
      if (body?.kinds !== undefined) {
        // Rejected rather than silently defaulted: on an edit, "none" is a
        // mistake the reader should see, not a reset to whatever we assume.
        const kinds = normaliseWatchKinds(body.kinds);
        if (!kinds) return sendPrivate(res, 400, { error: "choose at least one thing to watch for" });
        await sql(`update area_watches set kinds = $3 where id = $1 and user_id = $2`, [id, user.id, kinds]);
      }
      const rows = await sql(
        `select id, name, lat, lng, radius_m, kinds, alerts_enabled, created_at
         from area_watches where id = $1 and user_id = $2`,
        [id, user.id]
      );
      return sendPrivate(res, 200, rows[0] ?? null);
    }
    return sendPrivate(res, 405, { error: "PATCH or DELETE" });
  }

  if (route === "/api/saves" && req.method === "POST") {
    const body = await readJsonBody(req);
    const authorityId = String(body?.authority_id ?? "").slice(0, 80);
    const reference = String(body?.planning_reference ?? "").slice(0, 80);
    if (!authorityId || !reference)
      return sendPrivate(res, 400, { error: "authority_id and planning_reference required" });
    const saveCount = await sql(`select count(*)::int as n from saved_apps where user_id = $1`, [user.id]);
    if ((saveCount[0]?.n ?? 0) >= 200)
      return sendPrivate(res, 400, { error: "limit of 200 saved applications reached" });
    await sql(
      `insert into saved_apps (user_id, authority_id, planning_reference)
       values ($1, $2, $3)
       on conflict (user_id, authority_id, planning_reference) do nothing`,
      [user.id, authorityId, reference]
    );
    await seedSnapshot(authorityId, reference, ctx);
    const saves = await loadSaves(user.id, ctx);
    const created = saves.find(
      (s) => s.authority_id === authorityId && s.planning_reference === reference
    );
    return sendPrivate(res, 200, created);
  }

  const saveMatch = route.match(/^\/api\/saves\/(\d+)$/);
  if (saveMatch) {
    const id = Number(saveMatch[1]);
    if (req.method === "DELETE") {
      await sql(`delete from saved_apps where id = $1 and user_id = $2`, [id, user.id]);
      return sendPrivate(res, 200, { ok: true });
    }
    if (req.method === "PATCH") {
      const body = await readJsonBody(req);
      if (body?.seen === true)
        await sql(`update saved_apps set events_seen_at = now() where id = $1 and user_id = $2`, [id, user.id]);
      if (typeof body?.alerts_enabled === "boolean")
        await sql(`update saved_apps set alerts_enabled = $3 where id = $1 and user_id = $2`, [id, user.id, body.alerts_enabled]);
      const saves = await loadSaves(user.id, ctx);
      return sendPrivate(res, 200, saves.find((s) => s.id === id) ?? null);
    }
    return sendPrivate(res, 405, { error: "PATCH or DELETE" });
  }

  if (route === "/api/lists" && req.method === "POST") {
    const body = await readJsonBody(req);
    const name = String(body?.name ?? "").trim().slice(0, 80);
    if (!name) return sendPrivate(res, 400, { error: "name required" });
    const listCount = await sql(`select count(*)::int as n from lists where user_id = $1`, [user.id]);
    if ((listCount[0]?.n ?? 0) >= 50)
      return sendPrivate(res, 400, { error: "limit of 50 lists reached" });
    const rows = await sql(
      `insert into lists (user_id, name, position)
       values ($1, $2, coalesce((select max(position) + 1 from lists where user_id = $1), 0))
       returning id, name, position`,
      [user.id, name]
    );
    return sendPrivate(res, 200, { ...rows[0], alerts_enabled: true, item_ids: [] });
  }

  const itemDelMatch = route.match(/^\/api\/lists\/(\d+)\/items\/(\d+)$/);
  if (itemDelMatch && req.method === "DELETE") {
    await sql(
      `delete from list_items where list_id = $1 and saved_app_id = $2
       and exists (select 1 from lists where id = $1 and user_id = $3)`,
      [Number(itemDelMatch[1]), Number(itemDelMatch[2]), user.id]
    );
    return sendPrivate(res, 200, { ok: true });
  }

  const itemsMatch = route.match(/^\/api\/lists\/(\d+)\/items$/);
  if (itemsMatch && req.method === "POST") {
    const body = await readJsonBody(req);
    const listId = Number(itemsMatch[1]);
    const savedAppId = Number(body?.saved_app_id);
    if (!savedAppId) return sendPrivate(res, 400, { error: "saved_app_id required" });
    await sql(
      `insert into list_items (list_id, saved_app_id)
       select $1, $2 where exists (select 1 from lists where id = $1 and user_id = $3)
         and exists (select 1 from saved_apps where id = $2 and user_id = $3)
       on conflict do nothing`,
      [listId, savedAppId, user.id]
    );
    return sendPrivate(res, 200, { ok: true });
  }

  const listMatch = route.match(/^\/api\/lists\/(\d+)$/);
  if (listMatch) {
    const id = Number(listMatch[1]);
    if (req.method === "DELETE") {
      await sql(`delete from lists where id = $1 and user_id = $2`, [id, user.id]);
      return sendPrivate(res, 200, { ok: true });
    }
    if (req.method === "PATCH") {
      const body = await readJsonBody(req);
      if (typeof body?.name === "string" && body.name.trim())
        await sql(`update lists set name = $3 where id = $1 and user_id = $2`, [id, user.id, body.name.trim().slice(0, 80)]);
      if (typeof body?.alerts_enabled === "boolean")
        await sql(
          `update saved_apps set alerts_enabled = $3 where user_id = $2
           and id in (select saved_app_id from list_items where list_id = $1)`,
          [id, user.id, body.alerts_enabled]
        );
      const rows = await sql(`select id, name, position from lists where id = $1 and user_id = $2`, [id, user.id]);
      return sendPrivate(res, 200, rows[0] ?? null);
    }
    return sendPrivate(res, 405, { error: "PATCH or DELETE" });
  }

  return sendPrivate(res, 404, { error: "not found" });
}

async function handleCron(req, res, ctx) {
  const secret = process.env.CRON_SECRET;
  if (!verifyBearer(req, secret))
    return sendPrivate(res, 401, { error: "unauthorized" });

  const targets = await sql(
    `select distinct authority_id, planning_reference from saved_apps where alerts_enabled`
  );
  const snaps = await sql(`select authority_id, planning_reference, snapshot from app_snapshots`);
  const prevByKey = new Map(snaps.map((r) => [`${r.authority_id}|${r.planning_reference}`, r.snapshot]));

  let eventsWritten = 0;
  await mapLimit(targets, 4, async (t) => {
    try {
      const key = `${t.authority_id}|${t.planning_reference}`;
      const app = ctx.findApp(t.authority_id, t.planning_reference);
      const prev = prevByKey.get(key);
      // Kildare first from the council register: the national feed trails it by
      // ~3 months, so polling only that leaves Kildare saves effectively
      // unmonitored. Falls through to the national feed, then the bundle.
      let next =
        t.authority_id === "kildare"
          ? await fetchKildareLiveSnapshot(t.planning_reference)
          : null;
      if (!next) next = await fetchLiveNationalSnapshot(t.authority_id, t.planning_reference);
      if (!next) next = app ? snapshotFromBundleApp(app) : null;
      if (!next) return;
      if (app) {
        next.commencement_notice = app.commencement_notice ?? null;
        next.commencement_date = app.commencement_date ?? null;
        next.completion_date = app.completion_date ?? null;
      } else if (prev) {
        next.commencement_notice = prev.commencement_notice ?? null;
        next.commencement_date = prev.commencement_date ?? null;
        next.completion_date = prev.completion_date ?? null;
      }
      if (AGILE.has(t.authority_id) && app?.source_url) {
        let overlaid = false;
        try {
          const live = await ctx.fetchAgileDetail(t.authority_id, app.source_url, t.planning_reference);
          const mapped = live ? ctx.mapLiveStatus(live) : null;
          if (mapped && mapped !== "unknown") next.status = mapped;
          if (live?.decision) next.decision = live.decision;
          overlaid = Boolean(live);
        } catch {
          // Portal unreachable — fall through to the carry-forward below.
        }
        // The baseline for an agile council is portal-derived. Substituting the
        // national wording when the portal is down reads as a change, and the
        // next successful run reads as a change back: a flaky council portal
        // would alert forever. Carry the previous values instead.
        if (!overlaid && prev) {
          if (prev.status != null) next.status = prev.status;
          if (prev.decision != null) next.decision = prev.decision;
        }
      }
      if (prev) {
        for (const e of diffSnapshots(prev, next)) {
          await sql(
            `insert into app_events (authority_id, planning_reference, event_type, field, old_value, new_value, summary)
             values ($1, $2, $3, $4, $5, $6, $7)`,
            [t.authority_id, t.planning_reference, e.event_type, e.field, e.old_value, e.new_value, e.summary]
          );
          eventsWritten++;
        }
      }
      // Decision-due reminder: the statutory decide-by date is today or
      // tomorrow and the case still reads undecided. One event per due date —
      // the anti-join makes re-runs and FI-extended dates idempotent.
      const due = app?.decision_due_date;
      if (due) {
        const today = new Date().toISOString().slice(0, 10);
        const tomorrow = new Date(Date.now() + 86400_000).toISOString().slice(0, 10);
        const undecided = !["granted", "refused", "split", "withdrawn", "invalid", "exempt", "not_exempt", "decided"]
          .includes(normalizeStatus(next.status, next.decision));
        if (undecided && (due === today || due === tomorrow)) {
          const summary = `Decision due ${due === today ? "today" : "tomorrow"} (${fmtEventDate(due)}) — the council must decide by then unless it requests further information`;
          const inserted = await sql(
            `insert into app_events (authority_id, planning_reference, event_type, field, old_value, new_value, summary)
             select $1, $2, 'reminder', 'decision_due', null, $3, $4
             where not exists (
               select 1 from app_events
               where authority_id = $1 and planning_reference = $2
                 and field = 'decision_due' and new_value = $3
             ) returning id`,
            [t.authority_id, t.planning_reference, due, summary]
          );
          if (inserted.length) eventsWritten++;
        }
      }
      await sql(
        `insert into app_snapshots (authority_id, planning_reference, snapshot, fetched_at)
         values ($1, $2, $3::jsonb, now())
         on conflict (authority_id, planning_reference)
         do update set snapshot = excluded.snapshot, fetched_at = now()`,
        [t.authority_id, t.planning_reference, JSON.stringify(next)]
      );
    } catch (err) {
      console.error("check-updates: skipped", t.authority_id, t.planning_reference, err);
    }
  });

  // Area watches: sweep the bundle for recent activity inside each circle
  // that this watch hasn't alerted on yet. Detection failure must never block
  // the saved-app digests.
  const watchNewsByUser = new Map();
  let watchHitsFound = 0;
  try {
    await ensureWatchSchema();
    const watches = await sql(
      `select id, user_id, name, lat, lng, radius_m, kinds from area_watches where alerts_enabled`
    );
    const since = watchWindowStart();
    for (const w of watches) {
      const hits = findWatchHits(ctx.applications, w, since);
      if (!hits.length) continue;
      const alerted = await sql(
        `select authority_id, planning_reference, kind from area_watch_alerted where watch_id = $1`,
        [w.id]
      );
      const seen = new Set(alerted.map((r) => `${r.authority_id}|${r.planning_reference}|${r.kind}`));
      for (const h of hits) {
        for (const kind of h.kinds) {
          const key = `${h.app.authority_id}|${h.app.planning_reference}|${kind}`;
          if (seen.has(key)) continue;
          await sql(
            `insert into area_watch_alerted (watch_id, authority_id, planning_reference, kind)
             values ($1, $2, $3, $4) on conflict do nothing`,
            [w.id, h.app.authority_id, h.app.planning_reference, kind]
          );
          if (!watchNewsByUser.has(w.user_id)) watchNewsByUser.set(w.user_id, new Map());
          const byWatch = watchNewsByUser.get(w.user_id);
          if (!byWatch.has(w.id)) byWatch.set(w.id, { name: w.name, items: [] });
          byWatch.get(w.id).items.push({
            address: h.app.address_text ?? h.app.planning_reference,
            reference: h.app.planning_reference,
            summary: watchHitSummary(h.app, kind),
            authority_id: h.app.authority_id,
          });
          watchHitsFound++;
        }
      }
    }
  } catch (err) {
    console.error("area-watch sweep failed", err);
  }

  const origin = process.env.APP_ORIGIN;
  if (!origin) return sendPrivate(res, 500, { error: "APP_ORIGIN not set" });
  const users = await sql(
    `select id, email, coalesce(last_digest_at, created_at) as since from users`
  );
  let emailsSent = 0;
  for (const u of users) {
    const rows = await sql(
      `select s.authority_id, s.planning_reference, e.summary
       from saved_apps s
       join app_events e on e.authority_id = s.authority_id
         and e.planning_reference = s.planning_reference
       where s.user_id = $1 and s.alerts_enabled and e.detected_at > $2
       order by e.detected_at`,
      [u.id, u.since]
    );
    const watchNews = watchNewsByUser.get(u.id);
    if (!rows.length && !watchNews) continue;
    const byApp = new Map();
    for (const r of rows) {
      const key = `${r.authority_id}|${r.planning_reference}`;
      if (!byApp.has(key)) {
        const app = ctx.findApp(r.authority_id, r.planning_reference);
        byApp.set(key, {
          address: app?.address_text ?? r.planning_reference,
          reference: r.planning_reference,
          url: `${origin}/#app=${encodeURIComponent(r.authority_id)}:${encodeURIComponent(r.planning_reference)}`,
          summaries: [],
        });
      }
      byApp.get(key).summaries.push(r.summary);
    }
    const areaSections = watchNews
      ? [...watchNews.values()].map((wn) => ({
          name: wn.name,
          items: wn.items.map((i) => ({
            ...i,
            url: `${origin}/#app=${encodeURIComponent(i.authority_id)}:${encodeURIComponent(i.reference)}`,
          })),
        }))
      : [];
    const unsubUrl = `${origin}/api/alerts/unsubscribe?u=${u.id}&t=${unsubscribeToken(u.id)}`;
    try {
      await sendEmail({
        to: u.email,
        ...buildDigestEmail([...byApp.values()], unsubUrl, areaSections),
        headers: { "List-Unsubscribe": `<${unsubUrl}>` },
      });
      emailsSent++;
      await sql(`update users set last_digest_at = now() where id = $1`, [u.id]);
    } catch (err) {
      console.error("digest send failed", u.email, err);
    }
  }

  return sendPrivate(res, 200, {
    checked: targets.length,
    events: eventsWritten,
    watch_hits: watchHitsFound,
    emails: emailsSent,
  });
}
