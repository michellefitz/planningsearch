import type { FastifyInstance } from "fastify";
import type Database from "better-sqlite3";
import { AUTHORITY_BY_ID } from "./config/authorities.js";
import { APPLICATION_TYPE_LABELS, GLOSSARY, STATUS_LABELS } from "./normalize.js";
import { search, suggest, type SearchFilters } from "./search.js";

function csv(v: unknown): string[] | undefined {
  if (typeof v !== "string" || !v.trim()) return undefined;
  return v.split(",").map((s) => s.trim()).filter(Boolean);
}

function num(v: unknown): number | undefined {
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

function parseBbox(v: unknown): [number, number, number, number] | undefined {
  const parts = csv(v)?.map(Number);
  if (!parts || parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) return undefined;
  return parts as [number, number, number, number];
}

function filtersFromQuery(q: Record<string, unknown>): SearchFilters {
  const lat = num(q.lat);
  const lng = num(q.lng);
  return {
    q: typeof q.q === "string" ? q.q : undefined,
    authorities: csv(q.authority),
    statuses: csv(q.status),
    types: csv(q.type),
    domesticOnly: q.domestic === "1" || q.domestic === "true",
    receivedFrom: typeof q.receivedFrom === "string" ? q.receivedFrom : undefined,
    receivedTo: typeof q.receivedTo === "string" ? q.receivedTo : undefined,
    decisionFrom: typeof q.decisionFrom === "string" ? q.decisionFrom : undefined,
    decisionTo: typeof q.decisionTo === "string" ? q.decisionTo : undefined,
    bbox: parseBbox(q.bbox),
    near: lat !== undefined && lng !== undefined ? { lat, lng } : undefined,
    sort: ["relevance", "received", "decision", "distance"].includes(String(q.sort))
      ? (String(q.sort) as SearchFilters["sort"])
      : undefined,
    page: num(q.page),
    limit: num(q.limit),
  };
}

function publicApplication(row: Record<string, unknown>) {
  const auth = AUTHORITY_BY_ID.get(String(row.authority_id));
  return {
    ...row,
    is_domestic_guess: Boolean(row.is_domestic_guess),
    status_label: STATUS_LABELS[row.status as keyof typeof STATUS_LABELS] ?? String(row.status),
    application_type_label:
      APPLICATION_TYPE_LABELS[row.application_type as keyof typeof APPLICATION_TYPE_LABELS] ??
      String(row.application_type ?? ""),
    authority_name: auth?.name ?? row.authority_id,
    authority_short_name: auth?.shortName ?? row.authority_id,
    portal_url:
      (row.source_url as string | null) ??
      auth?.portalUrlForReference(String(row.planning_reference)) ??
      null,
  };
}

export function registerRoutes(app: FastifyInstance, db: Database.Database) {
  app.get("/api/meta", () => {
    const authorities = db
      .prepare(
        `SELECT a.id, a.name, a.short_name, a.source_system, a.portal_base_url, a.gis_url, a.last_synced,
                (SELECT COUNT(*) FROM applications ap WHERE ap.authority_id = a.id) AS application_count
         FROM authorities a ORDER BY a.name`
      )
      .all();
    return {
      authorities,
      statuses: STATUS_LABELS,
      application_types: APPLICATION_TYPE_LABELS,
      glossary: GLOSSARY,
      attribution:
        "Contains Irish Public Sector Data (Department of Housing, Local Government and Heritage) licensed under CC-BY 4.0. The local authority registers remain the authoritative source.",
    };
  });

  app.get("/api/search", (req) => {
    const filters = filtersFromQuery(req.query as Record<string, unknown>);
    const { results, total, fuzzy } = search(db, filters);
    return {
      total,
      fuzzy,
      page: filters.page ?? 1,
      results: results.map((r) => publicApplication(r as unknown as Record<string, unknown>)),
    };
  });

  app.get("/api/suggest", (req) => {
    const { q } = req.query as { q?: string };
    return { suggestions: q ? suggest(db, q) : [] };
  });

  // GeoJSON for the map layer; capped and bbox-filtered (PRD F2.1).
  app.get("/api/map/applications", (req) => {
    const filters = filtersFromQuery(req.query as Record<string, unknown>);
    filters.limit = 5000;
    filters.page = 1;
    const { results } = search(db, filters);
    return {
      type: "FeatureCollection",
      features: results
        .filter((r) => r.lat != null && r.lng != null)
        .map((r) => ({
          type: "Feature",
          geometry: { type: "Point", coordinates: [r.lng, r.lat] },
          properties: {
            id: r.id,
            reference: r.planning_reference,
            status: r.status,
            authority_id: r.authority_id,
            address: r.address_text,
            is_domestic_guess: Boolean(r.is_domestic_guess),
          },
        })),
    };
  });

  app.get("/api/applications/:id", (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    const row = db.prepare("SELECT * FROM applications WHERE id = ?").get(id) as
      | Record<string, unknown>
      | undefined;
    if (!row) return reply.code(404).send({ error: "Application not found" });
    const documents = db
      .prepare("SELECT * FROM documents WHERE application_id = ? ORDER BY id")
      .all(id);
    const related = db
      .prepare(
        `SELECT id, planning_reference, description, status, received_date, decision_date
         FROM applications
         WHERE id != @id AND authority_id = @authority_id AND address_text = @address_text
         ORDER BY received_date DESC LIMIT 10`
      )
      .all({ id, authority_id: row.authority_id, address_text: row.address_text });
    return { ...publicApplication(row), documents, related };
  });
}
