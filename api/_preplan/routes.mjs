/**
 * Pre-planner routes: auth-gated project CRUD + report generation/retrieval.
 * Persistence in Neon (same database as accounts). Reports are immutable
 * snapshots — GET renders stored JSON; generation always inserts a new row.
 */
import { sql } from "../_accounts/db.mjs";
import { currentUser } from "../_accounts/routes.mjs";
import {
  generateReport,
  PREPLAN_SYNTHESIS_PROMPT,
  PRECEDENT_SUMMARY_PROMPT,
  PRECEDENT_RADIUS_M,
  haversineMeters,
} from "./pipeline.mjs";
import { getDesignations, getFloodGround, getHeritagePoints } from "./pipeline.mjs";

export function isPreplanRoute(route) {
  return route === "/api/preplan/projects" || route.startsWith("/api/preplan/");
}

function send(res, code, body) {
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

// The tables are created lazily because sensitive env vars (DATABASE_URL)
// are not pullable locally to run the migration script from a dev machine.
let schemaReady = null;
function ensureSchema() {
  schemaReady ??= (async () => {
    await sql(`create table if not exists preplan_projects (
      id bigint generated always as identity primary key,
      user_id bigint not null references users(id) on delete cascade,
      label text not null,
      lat double precision not null,
      lng double precision not null,
      address text not null,
      eircode text,
      intent text not null,
      created_at timestamptz not null default now()
    )`);
    await sql(`create table if not exists preplan_reports (
      id bigint generated always as identity primary key,
      project_id bigint not null references preplan_projects(id) on delete cascade,
      status text not null default 'running',
      sections jsonb,
      narrative text,
      error text,
      generated_at timestamptz not null default now()
    )`);
  })().catch((err) => {
    schemaReady = null;
    throw err;
  });
  return schemaReady;
}

let staticCache = new Map();
async function loadStaticGeojsonFrom(host, name) {
  if (staticCache.has(name)) return staticCache.get(name);
  const res = await fetch(`https://${host}/${name}.geojson`);
  if (!res.ok) throw new Error(`static ${name}: HTTP ${res.status}`);
  const fc = await res.json();
  staticCache.set(name, fc);
  return fc;
}

async function fetchJson(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

function buildDeps(host, ctx) {
  const pointDeps = { fetchJson, loadStaticGeojson: (name) => loadStaticGeojsonFrom(host, name) };
  return {
    getDesignations: (lat, lng) => getDesignations(lat, lng, pointDeps),
    getHeritagePoints: (lat, lng) => getHeritagePoints(lat, lng, pointDeps),
    getFloodGround: (lat, lng) => getFloodGround(lat, lng, pointDeps),
    async getRows(lat, lng) {
      const apps = ctx.bundle.applications;
      const nearby = apps.filter(
        (a) => a.lat != null && a.lng != null && haversineMeters(lat, lng, a.lat, a.lng) <= PRECEDENT_RADIUS_M
      );
      const counts = new Map();
      for (const r of nearby) counts.set(r.authority_id, (counts.get(r.authority_id) ?? 0) + 1);
      const authorityId = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
      const authority = authorityId ? apps.filter((a) => a.authority_id === authorityId) : [];
      // geom_polygon can be tens of KB per row — never let it into the report.
      const label = ({ geom_polygon: _g, ...r }) => ({
        ...r,
        status_label: ctx.bundle.statuses?.[r.status] ?? r.status,
      });
      return { nearby: nearby.map(label), authority, authority_id: authorityId ?? null };
    },
    async readPrecedentDocument(p, question) {
      const tool = p.appeal_reference ? "read_appeal_document" : "read_document";
      const input = { application_id: p.id, question };
      if (!p.appeal_reference) input.title = "decision";
      const result = await ctx.executeAgentTool(tool, input);
      if (!result || result.error || !result.document || !result.answer) return null;
      return { document: result.document, answer: result.answer };
    },
    async summarisePrecedents(items) {
      const raw = await ctx.callClaude(PRECEDENT_SUMMARY_PROMPT, JSON.stringify(items), 1000, 30000);
      const match = raw?.match(/\{[\s\S]*\}/);
      return match ? JSON.parse(match[0]) : null;
    },
    synthesise: (packJson) => ctx.callClaude(PREPLAN_SYNTHESIS_PROMPT, packJson, 900, 60000),
  };
}

export async function handlePreplanRoute(req, res, route, url, ctx) {
  try {
    return await dispatch(req, res, route, url, ctx);
  } catch (err) {
    console.error("preplan route failed", route, err);
    return send(res, 500, { error: "something went wrong" });
  }
}

async function dispatch(req, res, route, url, ctx) {
  const user = await currentUser(req);
  if (!user) return send(res, 401, { error: "sign in required" });
  await ensureSchema();

  if (route === "/api/preplan/projects" && req.method === "GET") {
    const projects = await sql(
      `select p.*, r.id as latest_report_id, r.status as latest_report_status, r.generated_at as latest_report_at
       from preplan_projects p
       left join lateral (
         select id, status, generated_at from preplan_reports
         where project_id = p.id order by id desc limit 1
       ) r on true
       where p.user_id = $1 order by p.created_at desc`,
      [user.id]
    );
    const reports = await sql(
      `select r.id, r.project_id, r.status, r.generated_at from preplan_reports r
       join preplan_projects p on p.id = r.project_id where p.user_id = $1
       order by r.id desc`,
      [user.id]
    );
    return send(res, 200, { projects, reports });
  }

  if (route === "/api/preplan/projects" && req.method === "POST") {
    const body = await readJsonBody(req);
    const label = String(body?.label ?? "").trim();
    const address = String(body?.address ?? "").trim();
    const intent = String(body?.intent ?? "").trim();
    const eircode = body?.eircode ? String(body.eircode).trim() : null;
    const lat = Number(body?.lat);
    const lng = Number(body?.lng);
    if (!label || !intent || !Number.isFinite(lat) || !Number.isFinite(lng)) {
      return send(res, 400, { error: "label, intent and a location are required" });
    }
    const rows = await sql(
      `insert into preplan_projects (user_id, label, lat, lng, address, eircode, intent)
       values ($1, $2, $3, $4, $5, $6, $7) returning *`,
      [user.id, label, lat, lng, address || label, eircode, intent]
    );
    return send(res, 200, { project: rows[0] });
  }

  let m = route.match(/^\/api\/preplan\/projects\/(\d+)$/);
  if (m && req.method === "DELETE") {
    await sql(`delete from preplan_projects where id = $1 and user_id = $2`, [Number(m[1]), user.id]);
    return send(res, 200, { ok: true });
  }

  m = route.match(/^\/api\/preplan\/reports\/(\d+)$/);
  if (m && req.method === "GET") {
    const rows = await sql(
      `select r.*, p.label, p.address, p.eircode, p.intent, p.lat, p.lng
       from preplan_reports r join preplan_projects p on p.id = r.project_id
       where r.id = $1 and p.user_id = $2`,
      [Number(m[1]), user.id]
    );
    if (!rows.length) return send(res, 404, { error: "report not found" });
    return send(res, 200, { report: rows[0] });
  }

  m = route.match(/^\/api\/preplan\/projects\/(\d+)\/reports$/);
  if (m && req.method === "POST") {
    const projectId = Number(m[1]);
    const projects = await sql(`select * from preplan_projects where id = $1 and user_id = $2`, [
      projectId,
      user.id,
    ]);
    const project = projects[0];
    if (!project) return send(res, 404, { error: "project not found" });

    const inserted = await sql(
      `insert into preplan_reports (project_id, status) values ($1, 'running') returning id`,
      [projectId]
    );
    const reportId = inserted[0].id;

    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    const write = (ev) => res.write(`data: ${JSON.stringify(ev)}\n\n`);

    const host = req.headers.host ?? "planningsearch-server.vercel.app";
    const input = {
      lat: Number(project.lat),
      lng: Number(project.lng),
      address: project.address,
      intent: project.intent,
    };
    let finished = false;
    try {
      for await (const ev of generateReport(input, buildDeps(host, ctx))) {
        if (ev.type === "done") {
          await sql(
            `update preplan_reports set status = 'complete', sections = $2::jsonb, narrative = $3 where id = $1`,
            [reportId, JSON.stringify(ev.sections), ev.narrative]
          );
          finished = true;
          write({ ...ev, report_id: reportId });
        } else {
          write(ev);
        }
      }
    } catch (err) {
      console.error("preplan generation failed", err);
      write({ type: "error", message: "Report generation failed part-way — the sections gathered so far were saved." });
    } finally {
      if (!finished) {
        await sql(`update preplan_reports set status = 'error', error = 'generation did not complete' where id = $1`, [
          reportId,
        ]).catch(() => {});
      }
      res.end();
    }
    return;
  }

  return send(res, 404, { error: "not found" });
}
