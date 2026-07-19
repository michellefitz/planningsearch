import type { FastifyInstance } from "fastify";
import type Database from "better-sqlite3";
import { AUTHORITY_BY_ID } from "./config/authorities.js";
import { APPLICATION_TYPE_LABELS, GLOSSARY, STATUS_LABELS } from "./normalize.js";
import { search, suggest, type SearchFilters } from "./search.js";
import {
  countObjectionFiles,
  deriveScannedFilesUrl,
  fetchAgileFileList,
  fetchEplanningParties,
  fetchScannedDocument,
  fetchScannedFileList,
  resolveAgileApplicationUrl,
  type DiagnosticStep,
} from "./documents.js";
import { summariseDescription, summariseRefusal } from "./summarize.js";
import { AGILE_CLIENT_BY_AUTHORITY, fetchAgileConditions, fetchAgileParties } from "./agile.js";

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
    scanned_files_url: deriveScannedFilesUrl(
      String(row.authority_id),
      row.source_url as string | null,
      row.planning_reference as string | null
    ),
    // Agile portals need a click-time id lookup for a working deep link; the
    // UI routes the portal button via /api/applications/:id/portal when set.
    portal_resolver: Boolean(auth?.agileSlug),
    files_supported: Boolean(
      auth?.agileSlug ||
        deriveScannedFilesUrl(
          String(row.authority_id),
          row.source_url as string | null,
          row.planning_reference as string | null
        )
    ),
  };
}

const REFUSAL_SUMMARY_CACHE = new Map<number, string>();

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
      // SQLite deployments track freshness per authority via last_synced.
      source_updated_at: null,
      generated_at: null,
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

  // On-demand scanned-file listing (Kildare/eplanning for now): fetches the
  // council's public file-list page only when a user asks, never cached or
  // mirrored (PRD §7.3 deep-link tier plus).
  app.get("/api/applications/:id/files", async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    const row = db
      .prepare(
        "SELECT authority_id, source_url, planning_reference FROM applications WHERE id = ?"
      )
      .get(id) as
      | { authority_id: string; source_url: string | null; planning_reference: string }
      | undefined;
    if (!row) return reply.code(404).send({ error: "Application not found" });
    const debug = (req.query as { debug?: string }).debug === "1";
    const trace: DiagnosticStep[] | undefined = debug ? [] : undefined;

    // Councils with a directly-addressable HTML listing (Kildare's iDocs,
    // South Dublin's regref DMS) use the scraped path below. The remaining
    // Agile councils (Dublin City, Fingal) go via the citizen portal's JSON
    // API — direct download URLs, no session proxying needed.
    const listUrl = deriveScannedFilesUrl(row.authority_id, row.source_url, row.planning_reference);
    const auth = AUTHORITY_BY_ID.get(row.authority_id);
    if (!listUrl && auth?.agileSlug) {
      const result = await fetchAgileFileList(auth.agileSlug, row.planning_reference, trace);
      if (debug) return { agile: true, result, trace };
      if (!result) return { supported: false, files: null, list_url: null };
      return {
        supported: true,
        direct: true,
        list_url: result.applicationUrl,
        files: result.files.length ? result.files : null,
        objection_count: result.files.length ? countObjectionFiles(result.files) : null,
      };
    }
    if (!listUrl) {
      return { supported: false, files: null, list_url: null };
    }
    const files = await fetchScannedFileList(listUrl);
    if (debug) return { agile: false, list_url: listUrl, files, trace };
    return {
      supported: true,
      list_url: listUrl,
      files,
      objection_count: files ? countObjectionFiles(files) : null,
    };
  });

  // Resolve the official portal deep link at click time. Agile councils need
  // their internal application id (not derivable from the reference), so we
  // look it up live and redirect; everything else 302s straight to source_url.
  app.get("/api/applications/:id/portal", async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    const row = db
      .prepare(
        "SELECT authority_id, source_url, planning_reference FROM applications WHERE id = ?"
      )
      .get(id) as
      | { authority_id: string; source_url: string | null; planning_reference: string }
      | undefined;
    if (!row) return reply.code(404).send({ error: "Application not found" });
    const auth = AUTHORITY_BY_ID.get(row.authority_id);
    const fallback =
      row.source_url ?? auth?.portalUrlForReference(row.planning_reference) ?? null;
    const debug = (req.query as { debug?: string }).debug === "1";
    const trace: DiagnosticStep[] | undefined = debug ? [] : undefined;
    if (auth?.agileSlug) {
      const resolved = await resolveAgileApplicationUrl(
        auth.agileSlug,
        row.planning_reference,
        trace
      );
      if (debug) return { resolved, fallback, trace };
      if (resolved) return reply.redirect(resolved, 302);
    } else if (debug) {
      return { resolved: null, fallback, trace: [] };
    }
    if (!fallback) return reply.code(404).send({ error: "No portal link" });
    return reply.redirect(fallback, 302);
  });

  // Proxy a single document view. The council's file URLs are session-bound,
  // so each view re-establishes a fresh upstream session server-side and
  // streams the specific file back — self-contained per click.
  app.get("/api/applications/:id/files/:index", async (req, reply) => {
    const { id: rawId, index: rawIndex } = req.params as { id: string; index: string };
    const id = Number(rawId);
    const index = Number(rawIndex);
    if (!Number.isInteger(index) || index < 0) return reply.code(400).send({ error: "Bad index" });
    const row = db
      .prepare("SELECT authority_id, source_url, planning_reference FROM applications WHERE id = ?")
      .get(id) as
      | { authority_id: string; source_url: string | null; planning_reference: string }
      | undefined;
    if (!row) return reply.code(404).send({ error: "Application not found" });
    const listUrl = deriveScannedFilesUrl(row.authority_id, row.source_url, row.planning_reference);
    if (!listUrl) return reply.code(404).send({ error: "No scanned files source" });

    const query = req.query as Record<string, unknown>;
    const debug = query.debug === "1";
    const trace: DiagnosticStep[] | undefined = debug ? [] : undefined;
    const doc = await fetchScannedDocument(listUrl, index, 4_000_000, trace);
    if (debug) {
      return reply.send({ listUrl, index, result: doc === null ? "null" : doc === "too_large" ? "too_large" : "ok", trace });
    }
    if (doc === "too_large" || doc === null) {
      const reason =
        doc === "too_large"
          ? "This document is too large to display here."
          : "Couldn't retrieve this document from the council just now.";
      return reply
        .code(doc === "too_large" ? 413 : 502)
        .type("text/html")
        .send(
          `<!doctype html><meta charset="utf-8"><title>PlanView</title>
           <p>${reason}</p><p><a href="${listUrl}">Open it on the council's scanned-files viewer instead</a>.</p>`
        );
    }
    reply.header("Content-Type", doc.contentType);
    if (doc.disposition) reply.header("Content-Disposition", doc.disposition);
    reply.header("Cache-Control", "private, max-age=300");
    return reply.send(doc.body);
  });

  // Decision substance (conditions of grant / reasons for refusal / F.I.
  // directives) from the agile API — fetched on demand when the sheet opens.
  app.get("/api/applications/:id/conditions", async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    const row = db
      .prepare("SELECT authority_id, source_url, planning_reference FROM applications WHERE id = ?")
      .get(id) as
      | { authority_id: string; source_url: string | null; planning_reference: string }
      | undefined;
    if (!row) return reply.code(404).send({ error: "Application not found" });
    if (!(row.authority_id in AGILE_CLIENT_BY_AUTHORITY)) {
      return { supported: false, conditions: null };
    }
    const conditions = await fetchAgileConditions(
      row.authority_id,
      row.source_url,
      row.planning_reference
    );
    // Refusal reasons are dense planning prose — add a plain-English line
    // for the sheet header. Cached: the reasons never change once decided.
    const reasons = conditions?.items.filter((i) => i.code === "R") ?? [];
    let refusalSummary: string | null = null;
    if (reasons.length) {
      refusalSummary =
        REFUSAL_SUMMARY_CACHE.get(id) ?? (await summariseRefusal(reasons));
      if (refusalSummary) REFUSAL_SUMMARY_CACHE.set(id, refusalSummary);
    }
    return {
      supported: true,
      conditions: conditions ? { ...conditions, refusal_summary: refusalSummary } : null,
    };
  });

  app.get("/api/applications/:id", async (req, reply) => {
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

    // Slow upstream work (AI summary, party backfill) lives on /enrich so
    // the sheet renders immediately; cached values still come through here.
    return {
      ...publicApplication(row),
      ai_summary: (row.ai_summary as string | null) ?? null,
      documents,
      related,
    };
  });

  // Enrichment that needs upstream calls: AI summary (Haiku) plus applicant/
  // agent backfill — redacted/absent in the national dataset but published on
  // the council portals (eplanning for Kildare, agile API for South Dublin /
  // Dublin City / Fingal). Fetched in parallel, cached in the DB.
  app.get("/api/applications/:id/enrich", async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    const row = db.prepare("SELECT * FROM applications WHERE id = ?").get(id) as
      | Record<string, unknown>
      | undefined;
    if (!row) return reply.code(404).send({ error: "Application not found" });

    const needsParties = !row.applicant_name || !row.agent_name;
    const [aiSummary, parties] = await Promise.all([
      row.ai_summary
        ? Promise.resolve(row.ai_summary as string)
        : summariseDescription(row.description as string, row.application_type as string | null),
      !needsParties
        ? Promise.resolve({ applicant: null, agent: null })
        : String(row.authority_id) in AGILE_CLIENT_BY_AUTHORITY
          ? fetchAgileParties(
              row.authority_id as string,
              row.source_url as string | null,
              row.planning_reference as string
            )
          : row.source_url
            ? fetchEplanningParties(row.source_url as string)
            : Promise.resolve({ applicant: null, agent: null }),
    ]);

    if (aiSummary && !row.ai_summary) {
      db.prepare("UPDATE applications SET ai_summary = ? WHERE id = ?").run(aiSummary, id);
    }
    const applicant = (row.applicant_name as string | null) ?? parties.applicant;
    const agent = (row.agent_name as string | null) ?? parties.agent;
    if (parties.applicant || parties.agent) {
      db.prepare("UPDATE applications SET applicant_name = ?, agent_name = ? WHERE id = ?").run(
        applicant,
        agent,
        id
      );
    }
    return { ai_summary: aiSummary ?? null, applicant_name: applicant, agent_name: agent };
  });
}
