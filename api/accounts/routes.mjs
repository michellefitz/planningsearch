import { sql } from "./db.mjs";
import {
  clearSessionCookie, parseCookies, randomToken,
  SESSION_COOKIE, sessionCookie, sha256Hex,
} from "./tokens.mjs";
import { magicLinkEmail, sendEmail } from "./email.mjs";
import { diffSnapshots, snapshotFromBundleApp } from "./diff.mjs";
import { fetchLiveNationalSnapshot } from "./live.mjs";
import { buildDigestEmail } from "./digest.mjs";

const AGILE = new Set(["dublin-city", "fingal", "dlr", "south-dublin"]);

export function isAccountRoute(route) {
  return (
    route.startsWith("/api/auth/") ||
    route === "/api/me" ||
    route === "/api/saves" || route.startsWith("/api/saves/") ||
    route === "/api/lists" || route.startsWith("/api/lists/") ||
    route === "/api/resolve" ||
    route === "/api/cron/check-updates"
  );
}

function sendPrivate(res, code, body) {
  res.statusCode = code;
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(body));
}

async function readJsonBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
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
    `select id, authority_id, planning_reference, alerts_enabled, events_seen_at, created_at
     from saved_apps where user_id = $1 order by created_at desc`,
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
    const origin = process.env.APP_ORIGIN ?? `https://${req.headers.host}`;
    const link = `${origin}/api/auth/verify?token=${token}`;
    await sendEmail({ to: email, ...magicLinkEmail(link) });
    return sendPrivate(res, 200, { ok: true });
  }

  if (route === "/api/auth/verify") {
    const token = p.get("token") ?? "";
    const rows = token
      ? await sql(
          `update auth_tokens set used_at = now()
           where token_hash = $1 and used_at is null and expires_at > now()
           returning email`,
          [sha256Hex(token)]
        )
      : [];
    if (!rows.length) {
      res.statusCode = 302;
      res.setHeader("Location", "/#auth-expired");
      return res.end();
    }
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
    res.statusCode = 302;
    res.setHeader("Set-Cookie", sessionCookie(sess));
    res.setHeader("Location", "/#account");
    return res.end();
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

  if (route === "/api/cron/check-updates") return handleCron(req, res, ctx);

  const user = await currentUser(req);

  if (route === "/api/me") {
    if (!user) return sendPrivate(res, 200, { user: null, saves: [], lists: [] });
    const [saves, lists] = await Promise.all([loadSaves(user.id, ctx), loadLists(user.id)]);
    return sendPrivate(res, 200, { user: { email: user.email }, saves, lists });
  }

  if (!user) return sendPrivate(res, 401, { error: "sign in required" });

  if (route === "/api/saves" && req.method === "POST") {
    const body = await readJsonBody(req);
    const authorityId = String(body?.authority_id ?? "");
    const reference = String(body?.planning_reference ?? "");
    if (!authorityId || !reference)
      return sendPrivate(res, 400, { error: "authority_id and planning_reference required" });
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
    const name = String(body?.name ?? "").trim();
    if (!name) return sendPrivate(res, 400, { error: "name required" });
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
        await sql(`update lists set name = $3 where id = $1 and user_id = $2`, [id, user.id, body.name.trim()]);
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
  if (!secret || req.headers.authorization !== `Bearer ${secret}`)
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
      let next = await fetchLiveNationalSnapshot(t.authority_id, t.planning_reference);
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
        try {
          const live = await ctx.fetchAgileDetail(t.authority_id, app.source_url, t.planning_reference);
          const mapped = live ? ctx.mapLiveStatus(live) : null;
          if (mapped && mapped !== "unknown") next.status = mapped;
          if (live?.decision) next.decision = live.decision;
        } catch {
          // agile portal down: national snapshot still stands
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

  const origin = process.env.APP_ORIGIN ?? `https://${req.headers.host}`;
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
    if (!rows.length) continue;
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
    try {
      await sendEmail({ to: u.email, ...buildDigestEmail([...byApp.values()]) });
      emailsSent++;
      await sql(`update users set last_digest_at = now() where id = $1`, [u.id]);
    } catch (err) {
      console.error("digest send failed", u.email, err);
    }
  }

  return sendPrivate(res, 200, { checked: targets.length, events: eventsWritten, emails: emailsSent });
}
