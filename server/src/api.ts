import type { FastifyInstance } from "fastify";
import type Database from "better-sqlite3";
import { AUTHORITY_BY_ID } from "./config/authorities.js";
import {
  abpCaseUrl,
  fetchAppealCase,
  fetchAppealDocumentBase64,
  pickAppealDocument,
} from "./abp.js";
import { APPLICATION_TYPE_LABELS, GLOSSARY, STATUS_LABELS } from "./normalize.js";
import { search, suggest, type SearchFilters } from "./search.js";
import {
  countObjectionFiles,
  deriveScannedFilesUrl,
  fetchEplanningParties,
  fetchScannedDocument,
  fetchScannedFileList,
  presentDocument,
  safeFilename,
  type DiagnosticStep,
} from "./documents.js";
import {
  extractDecisionDocument,
  summariseAppeal,
  summariseDescription,
  summariseRefusal,
  type DecisionExtract,
} from "./summarize.js";
import { fetchZoning } from "./zoning.js";
import { fetchFlood } from "./flood.js";
import { fetchOverlay, isOverlayLayer } from "./overlays.js";
import {
  AGILE_CLIENT_BY_AUTHORITY,
  agilePortalUrl,
  fetchAgileConditions,
  fetchAgileDetail,
  fetchAgileDocument,
  fetchAgileDocumentList,
} from "./agile.js";
import { runAgent, type ChatTurn } from "./agent/agent.js";
import { buildToolExecutor } from "./agent/execute.js";

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
    appealedOnly: q.appealed === "1" || q.appealed === "true",
    commencedOnly: q.commenced === "1" || q.commenced === "true",
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
    // Deep link to the An Coimisiún Pleanála case file when the register
    // records an appeal reference (national dataset's AppealRefNumber).
    appeal_url: abpCaseUrl(row.appeal_reference as string | null),
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
const APPEAL_SUMMARY_CACHE = new Map<number, { summary: string; based_on_document: string | null }>();
const DECISION_SUMMARY_CACHE = new Map<number, DecisionExtract & { source_document: string | null }>();

/** Pick the decision-order document from a scanned-file listing. */
function findDecisionDocIndex(files: Array<{ title: string }>): number {
  const specific = files.findIndex((f) =>
    /notification of decision|decision order|manager.?s order|board order|order to (grant|refuse)/i.test(f.title)
  );
  if (specific >= 0) return specific;
  return files.findIndex((f) => /\bdecision\b|refus|grant of permission|\border\b/i.test(f.title));
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
    // South Dublin & Dublin City document servers) use the scraped path
    // below. Fingal has no such server, so its documents come from the Agile
    // citizen-portal API — listed here, streamed per click through the proxy
    // (the file bytes need the tenant headers a plain browser link can't add).
    const listUrl = deriveScannedFilesUrl(row.authority_id, row.source_url, row.planning_reference);
    const auth = AUTHORITY_BY_ID.get(row.authority_id);
    if (!listUrl && auth?.agileSlug) {
      const result = await fetchAgileDocumentList(
        row.authority_id,
        row.source_url,
        row.planning_reference,
        trace
      );
      if (debug) return { agile: true, result, trace };
      if (!result) return { supported: false, files: null, list_url: null };
      return {
        supported: true,
        list_url: result.applicationUrl,
        files: result.files.length ? result.files : null,
        objection_count: result.files.length ? countObjectionFiles(result.files) : null,
      };
    }
    if (!listUrl) {
      return { supported: false, files: null, list_url: null };
    }
    const files = await fetchScannedFileList(listUrl, trace);
    if (debug) return { agile: false, list_url: listUrl, files, trace };
    return {
      supported: true,
      list_url: listUrl,
      files,
      objection_count: files ? countObjectionFiles(files) : null,
    };
  });

  // On-demand An Coimisiún Pleanála (ABP/CP) appeal-case enrichment. The
  // summary fields (status, decision, dates) come from the register we already
  // hold; this pulls the fuller case detail — parties, board direction,
  // documentation links — live from the national case file, degrading to just
  // the summary + case link if the case site can't be reached.
  app.get("/api/applications/:id/appeal", async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    const row = db
      .prepare(
        `SELECT appeal_reference, appeal_status, appeal_lodged_date,
                appeal_decision, appeal_decision_date
         FROM applications WHERE id = ?`
      )
      .get(id) as
      | {
          appeal_reference: string | null;
          appeal_status: string | null;
          appeal_lodged_date: string | null;
          appeal_decision: string | null;
          appeal_decision_date: string | null;
        }
      | undefined;
    if (!row) return reply.code(404).send({ error: "Application not found" });
    const caseUrl = abpCaseUrl(row.appeal_reference);
    if (!caseUrl) return { supported: false };

    const debug = (req.query as { debug?: string }).debug === "1";
    const trace = debug ? [] : undefined;
    const details = await fetchAppealCase(caseUrl, trace);
    if (debug) return { case_url: caseUrl, details, trace };
    return {
      supported: true,
      case_url: caseUrl,
      reference: row.appeal_reference,
      status: row.appeal_status,
      lodged_date: row.appeal_lodged_date,
      decision: row.appeal_decision,
      decision_date: row.appeal_decision_date,
      // Null when the live case site couldn't be reached — the client then
      // shows the summary above plus the case-file link only.
      fields: details?.fields ?? null,
      documents: details?.documents ?? null,
    };
  });

  // AI plain-English summary of an appeal and its decision. Reads the most
  // relevant case document (board order / inspector's report) directly where
  // one is available, falling back to the structured record. On-demand and
  // cached — the model call plus a document fetch is too costly to run eagerly.
  app.get("/api/applications/:id/appeal-summary", async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    const row = db
      .prepare(
        `SELECT description, decision, appeal_reference, appeal_status,
                appeal_decision, appeal_decision_date
         FROM applications WHERE id = ?`
      )
      .get(id) as
      | {
          description: string | null;
          decision: string | null;
          appeal_reference: string | null;
          appeal_status: string | null;
          appeal_decision: string | null;
          appeal_decision_date: string | null;
        }
      | undefined;
    if (!row) return reply.code(404).send({ error: "Application not found" });
    const caseUrl = abpCaseUrl(row.appeal_reference);
    if (!caseUrl) return { supported: false };

    const cached = APPEAL_SUMMARY_CACHE.get(id);
    if (cached) return { supported: true, ...cached };

    const debug = (req.query as { debug?: string }).debug === "1";
    const trace = debug ? [] : undefined;
    const details = await fetchAppealCase(caseUrl, trace);

    const context = [
      row.description ? `Development: ${row.description}` : null,
      `Council decision: ${row.decision ?? "unknown"}`,
      row.appeal_status ? `Appeal status: ${row.appeal_status}` : null,
      row.appeal_decision
        ? `An Coimisiún Pleanála decision: ${row.appeal_decision}${row.appeal_decision_date ? ` on ${row.appeal_decision_date}` : ""}`
        : null,
      ...(details?.fields ?? []).map((f) => `${f.label}: ${f.value}`),
    ]
      .filter(Boolean)
      .join("\n");

    const doc = details ? pickAppealDocument(details.documents) : null;
    const pdf = doc ? await fetchAppealDocumentBase64(doc.url, 12_000_000, trace) : null;
    const summary = await summariseAppeal(context, pdf);

    if (debug) return { case_url: caseUrl, based_on_document: pdf ? doc?.title : null, summary, trace };
    if (!summary) return { supported: true, summary: null, based_on_document: null };
    const result = { summary, based_on_document: pdf ? (doc?.title ?? null) : null };
    APPEAL_SUMMARY_CACHE.set(id, result);
    return { supported: true, ...result };
  });

  // AI summary of a council decision from its scanned decision-order PDF, for
  // eplanning/iDocs councils (Kildare) that expose no structured conditions —
  // the reasons for refusal only exist in that document.
  app.get("/api/applications/:id/decision-summary", async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    const row = db
      .prepare(
        "SELECT authority_id, source_url, planning_reference, decision FROM applications WHERE id = ?"
      )
      .get(id) as
      | { authority_id: string; source_url: string | null; planning_reference: string; decision: string | null }
      | undefined;
    if (!row) return reply.code(404).send({ error: "Application not found" });
    const listUrl = deriveScannedFilesUrl(row.authority_id, row.source_url, row.planning_reference);
    // Only councils without a structured conditions API need this, and only
    // once a decision is on record.
    if (!listUrl || AGILE_CLIENT_BY_AUTHORITY[row.authority_id] || !row.decision) {
      return { supported: false };
    }
    const cached = DECISION_SUMMARY_CACHE.get(id);
    if (cached) return { supported: true, ...cached };

    const debug = (req.query as { debug?: string }).debug === "1";
    const trace: DiagnosticStep[] | undefined = debug ? [] : undefined;
    const files = await fetchScannedFileList(listUrl, trace);
    const index = files ? findDecisionDocIndex(files) : -1;
    if (debug) {
      const doc = index >= 0 ? await fetchScannedDocument(listUrl, index, 10_000_000, trace) : null;
      return {
        files,
        chosen: index,
        chosen_title: index >= 0 ? files![index].title : null,
        doc: doc === "too_large" ? "too_large" : doc ? doc.contentType : "null",
        trace,
      };
    }
    const empty = { supported: true, summary: null, conditions: [], reasons: [], source_document: null };
    if (!files || index < 0) return empty;

    const doc = await fetchScannedDocument(listUrl, index, 10_000_000, trace);
    if (!doc || doc === "too_large") return { ...empty, source_document: files[index].title };
    const isPdf = /pdf/i.test(doc.contentType) || /\.pdf$/i.test(doc.filename ?? "");
    const extract = isPdf ? await extractDecisionDocument(doc.body.toString("base64"), row.decision) : null;
    const source_document = files[index].title;
    if (!extract) return { ...empty, source_document };
    const result = { ...extract, source_document };
    DECISION_SUMMARY_CACHE.set(id, result);
    return { supported: true, ...result };
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
      const resolved = await agilePortalUrl(
        row.authority_id,
        row.source_url,
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
    const query = req.query as Record<string, unknown>;
    const debug = query.debug === "1";
    const trace: DiagnosticStep[] | undefined = debug ? [] : undefined;

    const listUrl = deriveScannedFilesUrl(row.authority_id, row.source_url, row.planning_reference);
    const auth = AUTHORITY_BY_ID.get(row.authority_id);

    // Fingal (Agile API) vs. HTML-listing councils use different fetchers,
    // but both stream one document by list index and degrade to the portal.
    const doc =
      !listUrl && auth?.agileSlug
        ? await fetchAgileDocument(row.authority_id, row.source_url, row.planning_reference, index, 4_000_000, trace)
        : listUrl
          ? await fetchScannedDocument(listUrl, index, 4_000_000, trace)
          : null;

    if (debug) {
      return reply.send({
        listUrl,
        index,
        result: doc === null ? "null" : doc === "too_large" ? "too_large" : "ok",
        trace,
      });
    }
    if (doc === "too_large" || doc === null) {
      // Land the user on the specific application, not the generic portal.
      const fallbackUrl =
        listUrl ??
        (auth?.agileSlug
          ? (await agilePortalUrl(row.authority_id, row.source_url, row.planning_reference)) ??
            auth.portalBaseUrl
          : auth?.portalBaseUrl ?? "");
      const reason =
        doc === "too_large"
          ? "This document is too large to display here."
          : "Couldn't retrieve this document from the council just now.";
      return reply
        .code(doc === "too_large" ? 413 : 502)
        .type("text/html")
        .send(
          `<!doctype html><meta charset="utf-8"><title>PlanView</title>
           <p>${reason}</p><p><a href="${fallbackUrl}">Open it on the council's viewer instead</a>.</p>`
        );
    }
    // Open PDFs/images in the tab; download only what the browser can't render.
    const { contentType, disposition } = presentDocument(doc.contentType, doc.filename);
    const cd = doc.filename ? `${disposition}; filename="${safeFilename(doc.filename)}"` : disposition;
    reply.header("Content-Type", contentType);
    reply.header("Content-Disposition", cd);
    reply.header("Cache-Control", "private, max-age=300");
    return reply.send(doc.body);
  });

  // Decision substance (conditions of grant / reasons for refusal / F.I.
  // directives) from the agile API — fetched on demand when the sheet opens.
  // Land-use zoning at the application's location, from the national GZT
  // layer (MyPlan / DHLGH) — one live point-in-polygon query, on demand.
  app.get("/api/applications/:id/zoning", async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    const row = db
      .prepare("SELECT lat, lng FROM applications WHERE id = ?")
      .get(id) as { lat: number | null; lng: number | null } | undefined;
    if (!row) return reply.code(404).send({ error: "Application not found" });
    if (row.lat == null || row.lng == null) return { supported: false, zones: null };
    const zones = await fetchZoning(row.lat, row.lng);
    return { supported: true, zones };
  });

  // Indicative flood-risk at the application's location, from the OPW's
  // national flood-mapping ArcGIS service — one live point query, on demand.
  app.get("/api/applications/:id/flood", async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    const row = db
      .prepare("SELECT lat, lng FROM applications WHERE id = ?")
      .get(id) as { lat: number | null; lng: number | null } | undefined;
    if (!row) return reply.code(404).send({ error: "Application not found" });
    if (row.lat == null || row.lng == null) return { supported: false, flood: null };
    const debug = (req.query as { debug?: string }).debug === "1";
    const trace = debug ? [] : undefined;
    const flood = await fetchFlood(row.lat, row.lng, trace);
    if (debug) return { flood, trace };
    return { supported: true, flood };
  });

  // Polygon overlays (zoning, flood) as GeoJSON for the current map viewport.
  app.get("/api/overlays/:layer", async (req, reply) => {
    const layer = (req.params as { layer: string }).layer;
    if (!isOverlayLayer(layer)) return reply.code(404).send({ error: "Unknown overlay" });
    const bbox = parseBbox((req.query as { bbox?: string }).bbox);
    if (!bbox) return { type: "FeatureCollection", features: [] };
    return fetchOverlay(layer, bbox);
  });

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
    // The plain-English refusal line is its own (cached) endpoint so the
    // conditions themselves never wait on a model call.
    return {
      supported: true,
      conditions: conditions
        ? { ...conditions, refusal_summary: REFUSAL_SUMMARY_CACHE.get(id) ?? null }
        : null,
    };
  });

  // Plain-English summary of the refusal reasons — dense planning prose in
  // the register. Split from /conditions so those render without waiting on
  // the model; cached because the reasons never change once decided.
  app.get("/api/applications/:id/refusal-summary", async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    const row = db
      .prepare("SELECT authority_id, source_url, planning_reference FROM applications WHERE id = ?")
      .get(id) as
      | { authority_id: string; source_url: string | null; planning_reference: string }
      | undefined;
    if (!row) return reply.code(404).send({ error: "Application not found" });
    if (!(row.authority_id in AGILE_CLIENT_BY_AUTHORITY)) {
      return { supported: false, summary: null };
    }
    const conditions = await fetchAgileConditions(
      row.authority_id,
      row.source_url,
      row.planning_reference
    );
    const reasons = conditions?.items.filter((i) => i.code === "R") ?? [];
    let summary: string | null = null;
    if (reasons.length) {
      summary = REFUSAL_SUMMARY_CACHE.get(id) ?? (await summariseRefusal(reasons));
      if (summary) REFUSAL_SUMMARY_CACHE.set(id, summary);
    }
    return { supported: true, summary };
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

    const authorityId = String(row.authority_id);
    const dbDescription = (row.description as string | null) ?? null;
    let description = dbDescription;
    let parties = { applicant: null, agent: null } as { applicant: string | null; agent: string | null };

    // The summary runs on the description we already hold, in parallel with
    // the party/description backfill — waiting on the portal before starting
    // the model call is what made the sheet feel slow. Only when the quick
    // pass can't produce a summary (usually a truncated national description)
    // and the portal supplied a fuller one do we summarise again.
    const debug = (req.query as { debug?: string }).debug === "1";
    const isAgile = authorityId in AGILE_CLIENT_BY_AUTHORITY;
    const [detail, eplanningParties, quickSummary] = await Promise.all([
      isAgile
        ? fetchAgileDetail(
            authorityId,
            row.source_url as string | null,
            row.planning_reference as string,
            debug
          )
        : null,
      !isAgile && (!row.applicant_name || !row.agent_name) && row.source_url
        ? fetchEplanningParties(row.source_url as string)
        : null,
      row.ai_summary
        ? (row.ai_summary as string)
        : summariseDescription(dbDescription ?? "", row.application_type as string | null),
    ]);
    if (isAgile) {
      if (detail) {
        parties = { applicant: detail.applicant, agent: detail.agent };
        if (detail.description && detail.description.length > (description?.length ?? 0)) {
          description = detail.description;
        }
        if (debug) {
          return {
            agile_detail_keys: detail.keys ?? null,
            picked_description_len: detail.description?.length ?? 0,
            description,
          };
        }
      } else if (debug) {
        return { agile_detail_keys: null, picked_description_len: 0, description };
      }
    } else if (eplanningParties) {
      parties = eplanningParties;
    }

    const descriptionImproved = !!description && description !== dbDescription;
    const aiSummary =
      quickSummary ??
      (descriptionImproved
        ? await summariseDescription(description ?? "", row.application_type as string | null)
        : null);

    if (aiSummary && aiSummary !== row.ai_summary) {
      db.prepare("UPDATE applications SET ai_summary = ? WHERE id = ?").run(aiSummary, id);
    }
    if (descriptionImproved) {
      db.prepare("UPDATE applications SET description = ? WHERE id = ?").run(description, id);
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
    // The national dataset's postcode field is ~2% populated, but the agile
    // register's detail response often carries a real Eircode — backfill it.
    const eircode = (row.eircode as string | null) ?? detail?.eircode ?? null;
    if (!row.eircode && detail?.eircode) {
      db.prepare("UPDATE applications SET eircode = ? WHERE id = ?").run(detail.eircode, id);
    }
    return {
      ai_summary: aiSummary ?? null,
      applicant_name: applicant,
      agent_name: agent,
      description,
      eircode,
    };
  });

  app.post("/api/agent", async (req, reply) => {
    const body = req.body as { messages?: Array<{ role?: string; content?: string }> } | null;
    const messages: ChatTurn[] = (body?.messages ?? [])
      .filter(
        (m): m is { role: "user" | "assistant"; content: string } =>
          m != null &&
          typeof m === "object" &&
          (m.role === "user" || m.role === "assistant") &&
          typeof m.content === "string" &&
          m.content.trim().length > 0
      )
      .slice(-30);
    while (messages.length && messages[0].role !== "user") messages.shift();
    if (!messages.length || messages[messages.length - 1].role !== "user") {
      return reply.code(400).send({ error: "messages must end with a user message" });
    }

    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    const executeTool = buildToolExecutor(db);
    try {
      for await (const ev of runAgent({ messages, executeTool })) {
        reply.raw.write(`data: ${JSON.stringify(ev)}\n\n`);
      }
    } catch {
      reply.raw.write(`data: ${JSON.stringify({ type: "error", message: "Agent crashed" })}\n\n`);
    } finally {
      reply.raw.end();
    }
  });
}
