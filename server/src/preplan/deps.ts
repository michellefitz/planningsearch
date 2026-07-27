/** Real dependency wiring for the pre-planner pipeline (Fastify server). */
import { readFile } from "node:fs/promises";
import path from "node:path";
import type Database from "better-sqlite3";
import { buildToolExecutor } from "../agent/execute.js";
import { STATUS_LABELS } from "../normalize.js";
import { callClaude } from "../summarize.js";
import {
  getDesignations,
  getFloodGround,
  getHeritagePoints,
  type PointDeps,
  type StaticGeojson,
} from "./point-data.js";
import { PRECEDENT_RADIUS_M, type PrecedentSourceRow, type ScoredPrecedent } from "./precedents.js";
import { PREPLAN_SYNTHESIS_PROMPT, type ReportDeps } from "./report.js";

const FETCH_TIMEOUT_MS = 15_000;

async function fetchJson(url: string): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

const WEB_PUBLIC = process.env.PLANVIEW_WEB_PUBLIC ?? path.resolve(process.cwd(), "../web/public");

async function loadStaticGeojson(name: "aca" | "flood"): Promise<StaticGeojson> {
  const raw = await readFile(path.join(WEB_PUBLIC, `${name}.geojson`), "utf8");
  return JSON.parse(raw) as StaticGeojson;
}

const ROW_COLUMNS =
  "id, authority_id, planning_reference, description, ai_summary, source_url, status, decision, " +
  "decision_date, received_date, address_text, lat, lng, appeal_reference";

type DbRow = PrecedentSourceRow & { id: number };

export function buildReportDeps(db: Database.Database): ReportDeps {
  const pointDeps: PointDeps = { fetchJson, loadStaticGeojson };
  const executeTool = buildToolExecutor(db);

  return {
    getDesignations: (lat, lng) => getDesignations(lat, lng, pointDeps),
    getHeritagePoints: (lat, lng) => getHeritagePoints(lat, lng, pointDeps),
    getFloodGround: (lat, lng) => getFloodGround(lat, lng, pointDeps),

    async getRows(lat, lng) {
      const dLat = PRECEDENT_RADIUS_M / 111_320;
      const dLng = PRECEDENT_RADIUS_M / (111_320 * Math.cos((lat * Math.PI) / 180));
      const nearby = db
        .prepare(
          `SELECT ${ROW_COLUMNS} FROM applications WHERE lat BETWEEN ? AND ? AND lng BETWEEN ? AND ?`
        )
        .all(lat - dLat, lat + dLat, lng - dLng, lng + dLng) as DbRow[];
      // The deciding authority = the one most represented right around the site.
      const counts = new Map<string, number>();
      for (const r of nearby) counts.set(r.authority_id, (counts.get(r.authority_id) ?? 0) + 1);
      const authorityId = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
      const authority = authorityId
        ? (db
            .prepare(`SELECT ${ROW_COLUMNS} FROM applications WHERE authority_id = ?`)
            .all(authorityId) as DbRow[])
        : [];
      const label = (r: DbRow) => ({
        ...r,
        status_label: (STATUS_LABELS as Record<string, string>)[r.status ?? ""] ?? r.status,
      });
      return { nearby: nearby.map(label), authority, authority_id: authorityId ?? null };
    },

    async readPrecedentDocument(p: ScoredPrecedent, question: string) {
      const id = (p as Partial<DbRow>).id;
      if (!Number.isFinite(id)) return null;
      const tool = p.appeal_reference ? "read_appeal_document" : "read_document";
      const input: Record<string, unknown> = { application_id: id, question };
      if (!p.appeal_reference) input.title = "decision";
      const result = (await executeTool(tool, input)) as
        | { document?: string; answer?: string; error?: string }
        | null;
      if (!result || result.error || !result.document || !result.answer) return null;
      return { document: result.document, answer: result.answer };
    },

    synthesise: (packJson) => callClaude(PREPLAN_SYNTHESIS_PROMPT, packJson, 900, 60_000),
  };
}
