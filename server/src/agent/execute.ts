import type Database from "better-sqlite3";
import { aggregateApplications, search as realSearch } from "../search.js";
import {
  AGILE_CLIENT_BY_AUTHORITY,
  fetchAgileConditions,
  fetchAgileDocument,
  fetchAgileDocumentList,
} from "../agile.js";
import { fetchZoning } from "../zoning.js";
import { abpCaseUrl, fetchAppealCase, fetchAppealDocumentBase64, pickAppealDocument } from "../abp.js";
import { deriveScannedFilesUrl, fetchScannedDocument, fetchScannedFileList } from "../documents.js";
import { readDocumentWithClaude } from "../summarize.js";
import { STATUS_LABELS } from "../normalize.js";
import { searchFiltersFromToolInput } from "./tools.js";

export interface ToolDeps {
  search: typeof realSearch;
  fetchAgileConditions: typeof fetchAgileConditions;
  fetchZoning: typeof fetchZoning;
  fetchAppealCase: typeof fetchAppealCase;
  fetchScannedFileList: typeof fetchScannedFileList;
  fetchAgileDocumentList: typeof fetchAgileDocumentList;
  fetchAppealDocumentBase64: typeof fetchAppealDocumentBase64;
  fetchScannedDocument: typeof fetchScannedDocument;
  fetchAgileDocument: typeof fetchAgileDocument;
  readDocumentWithClaude: typeof readDocumentWithClaude;
}

const REAL_DEPS: ToolDeps = {
  search: realSearch,
  fetchAgileConditions,
  fetchZoning,
  fetchAppealCase,
  fetchScannedFileList,
  fetchAgileDocumentList,
  fetchAppealDocumentBase64,
  fetchScannedDocument,
  fetchAgileDocument,
  readDocumentWithClaude,
};

const PDF_URL_RE = /\.pdf($|[?#])/i;

/** Pick the listed title that best matches the model's words: prefer a title
 *  containing every word, fall back to any word. -1 when nothing matches. */
export function matchDocumentTitle(titles: string[], want: string): number {
  const words = want.toLowerCase().split(/\s+/).filter((w) => w.length > 2);
  if (!words.length) return -1;
  const all = titles.findIndex((t) => words.every((w) => t.toLowerCase().includes(w)));
  if (all >= 0) return all;
  return titles.findIndex((t) => words.some((w) => t.toLowerCase().includes(w)));
}

export interface AgentAppSummary {
  id: number;
  authority_id: string;
  planning_reference: string;
  description: string | null;
  status: string;
  status_label: string;
  application_type: string | null;
  is_domestic_guess: boolean;
  received_date: string | null;
  decision: string | null;
  decision_date: string | null;
  address_text: string | null;
  lat: number | null;
  lng: number | null;
  appeal_reference?: string | null;
  /** BCMS: notified start of works / completion certificate, when filed. */
  commencement_date?: string | null;
  completion_date?: string | null;
  /** Set when the search was scoped near a point — how far this app is. */
  distance_km?: number;
}

export function toolAppSummary(row: Record<string, unknown>): AgentAppSummary {
  return {
    id: Number(row.id),
    authority_id: String(row.authority_id),
    planning_reference: String(row.planning_reference),
    description: (row.description as string | null) ?? null,
    status: String(row.status),
    status_label: STATUS_LABELS[row.status as keyof typeof STATUS_LABELS] ?? String(row.status),
    application_type: (row.application_type as string | null) ?? null,
    is_domestic_guess: Boolean(row.is_domestic_guess),
    received_date: (row.received_date as string | null) ?? null,
    decision: (row.decision as string | null) ?? null,
    decision_date: (row.decision_date as string | null) ?? null,
    address_text: (row.address_text as string | null) ?? null,
    lat: (row.lat as number | null) ?? null,
    lng: (row.lng as number | null) ?? null,
    appeal_reference: (row.appeal_reference as string | null) ?? null,
    commencement_date: (row.commencement_date as string | null) ?? null,
    completion_date: (row.completion_date as string | null) ?? null,
    ...(typeof (row as { distance_km?: number }).distance_km === "number"
      ? { distance_km: (row as { distance_km: number }).distance_km }
      : {}),
  };
}

export function buildToolExecutor(db: Database.Database, deps: Partial<ToolDeps> = {}) {
  const d = { ...REAL_DEPS, ...deps };

  const getRow = (input: Record<string, unknown>): Record<string, unknown> | null => {
    const id = Number(input.application_id);
    if (!Number.isFinite(id)) return null;
    return (db.prepare("SELECT * FROM applications WHERE id = ?").get(id) as
      | Record<string, unknown>
      | undefined) ?? null;
  };

  return async (name: string, input: Record<string, unknown>): Promise<unknown> => {
    switch (name) {
      case "count_applications": {
        return aggregateApplications(db, searchFiltersFromToolInput(input));
      }
      case "search_applications": {
        const filters = searchFiltersFromToolInput(input);
        const { results, total, fuzzy } = d.search(db, filters);
        return {
          total,
          fuzzy,
          returned: results.length,
          sample_basis: filters.sort === "distance" ? "nearest" : filters.sort === "received" ? "recent" : "relevance",
          results: results.map((r) => toolAppSummary(r as never)),
        };
      }
      case "get_application_detail": {
        const row = getRow(input);
        if (!row) return { error: "Application not found" };
        const { geom_polygon: _g, ai_summary: _s, ...rest } = row;
        return rest;
      }
      case "get_conditions": {
        const row = getRow(input);
        if (!row) return { error: "Application not found" };
        const authorityId = String(row.authority_id);
        if (!AGILE_CLIENT_BY_AUTHORITY[authorityId]) {
          return {
            available: false,
            note: "Conditions text is not published in a fetchable form by this council; the register holds only the decision outcome.",
          };
        }
        const conditions = await d.fetchAgileConditions(
          authorityId,
          (row.source_url as string | null) ?? null,
          String(row.planning_reference)
        );
        return conditions ?? { available: false, note: "No conditions returned by the council system." };
      }
      case "get_zoning": {
        const row = getRow(input);
        if (!row) return { error: "Application not found" };
        if (row.lat == null || row.lng == null) return { error: "Application has no coordinates" };
        return (await d.fetchZoning(Number(row.lat), Number(row.lng))) ?? { error: "Zoning lookup failed" };
      }
      case "get_appeal": {
        const row = getRow(input);
        if (!row) return { error: "Application not found" };
        const ref = (row.appeal_reference as string | null) ?? null;
        const url = abpCaseUrl(ref);
        if (!ref || !url) return { error: "No appeal on this application" };
        const kase = await d.fetchAppealCase(url);
        return kase ?? { error: "Could not load the appeal case page", case_url: url };
      }
      case "get_documents": {
        const row = getRow(input);
        if (!row) return { error: "Application not found" };
        const listUrl = deriveScannedFilesUrl(
          String(row.authority_id),
          (row.source_url as string | null) ?? null,
          (row.planning_reference as string | null) ?? null
        );
        // Fingal/DLR have no HTML listing; use the Agile portal API like /files does.
        if (!listUrl && AGILE_CLIENT_BY_AUTHORITY[String(row.authority_id)]) {
          const result = await d.fetchAgileDocumentList(
            String(row.authority_id),
            (row.source_url as string | null) ?? null,
            String(row.planning_reference)
          );
          if (!result) return { error: "Could not load the document list" };
          return { count: result.files.length, files: result.files.map((f) => ({ title: f.title })) };
        }
        if (!listUrl) return { error: "No document listing available for this council" };
        const files = await d.fetchScannedFileList(listUrl);
        if (!files) return { error: "Could not load the document list" };
        return { count: files.length, files: files.map((f) => ({ title: f.title })) };
      }
      case "read_appeal_document": {
        const row = getRow(input);
        if (!row) return { error: "Application not found" };
        const ref = (row.appeal_reference as string | null) ?? null;
        const url = abpCaseUrl(ref);
        if (!ref || !url) return { error: "No appeal on this application" };
        const kase = await d.fetchAppealCase(url);
        if (!kase) return { error: "Could not load the appeal case page", case_url: url };
        const pdfs = (kase.documents ?? []).filter((doc) => PDF_URL_RE.test(doc.url));
        if (!pdfs.length) {
          return { error: "The case file lists no fetchable PDF documents", case_url: url };
        }
        const want = typeof input.document === "string" ? input.document.trim() : "";
        let doc = null;
        if (want) {
          const idx = matchDocumentTitle(pdfs.map((p) => p.title), want);
          doc = idx >= 0 ? pdfs[idx] : null;
          if (!doc) {
            return { error: "No case document matches that name", available: pdfs.map((p) => p.title) };
          }
        } else {
          doc = pickAppealDocument(kase.documents ?? []);
        }
        if (!doc) return { error: "No readable case document", available: pdfs.map((p) => p.title) };
        const pdf = await d.fetchAppealDocumentBase64(doc.url);
        if (!pdf) {
          return {
            error: "Could not fetch that document (unreachable, not a PDF, or too large to read)",
            document: doc.title,
            available: pdfs.map((p) => p.title),
          };
        }
        const context =
          `Appeal ${ref} to An Coimisiún Pleanála — ${String(row.address_text ?? row.planning_reference)}. ` +
          `Document: ${doc.title}.`;
        const answer = await d.readDocumentWithClaude(pdf, context, input.question as string | undefined);
        if (!answer) return { error: "Fetched the document but could not read it", document: doc.title };
        return {
          document: doc.title,
          other_documents: pdfs.filter((p) => p !== doc).map((p) => p.title),
          answer,
        };
      }
      case "read_document": {
        const row = getRow(input);
        if (!row) return { error: "Application not found" };
        const want = typeof input.title === "string" ? input.title.trim() : "";
        if (!want) return { error: "title is required — call get_documents first to see the titles" };
        const authorityId = String(row.authority_id);
        const sourceUrl = (row.source_url as string | null) ?? null;
        const reference = String(row.planning_reference);
        const question = input.question as string | undefined;

        const listUrl = deriveScannedFilesUrl(authorityId, sourceUrl, reference);
        let fetched;
        let title: string;
        let titles: string[];
        if (listUrl) {
          const files = await d.fetchScannedFileList(listUrl);
          if (!files) return { error: "Could not load the document list" };
          titles = files.map((f) => f.title);
          const idx = matchDocumentTitle(titles, want);
          if (idx < 0) return { error: "No document matches that title", available: titles };
          title = titles[idx];
          fetched = await d.fetchScannedDocument(listUrl, idx, 10_000_000);
        } else if (AGILE_CLIENT_BY_AUTHORITY[authorityId]) {
          const result = await d.fetchAgileDocumentList(authorityId, sourceUrl, reference);
          if (!result) return { error: "Could not load the document list" };
          titles = result.files.map((f) => f.title);
          const idx = matchDocumentTitle(titles, want);
          if (idx < 0) return { error: "No document matches that title", available: titles };
          title = titles[idx];
          fetched = await d.fetchAgileDocument(authorityId, sourceUrl, reference, idx, 10_000_000);
        } else {
          return { error: "No document listing available for this council" };
        }
        if (fetched === "too_large") return { error: "That document is too large to read", document: title };
        if (!fetched) return { error: "Could not fetch the document", document: title };
        const isPdf = /pdf/i.test(fetched.contentType) || /\.pdf$/i.test(fetched.filename ?? "");
        if (!isPdf) {
          return {
            error: `That document is not a PDF (${fetched.contentType}) — only PDFs can be read`,
            document: title,
          };
        }
        const context =
          `Council document for planning application ${reference} — ` +
          `${String(row.address_text ?? reference)}. Document: ${title}.`;
        const answer = await d.readDocumentWithClaude(fetched.body.toString("base64"), context, question);
        if (!answer) return { error: "Fetched the document but could not read it", document: title };
        return { document: title, answer };
      }
      case "geocode_location": {
        const q = typeof input.location === "string" ? input.location.trim() : "";
        if (!q) return { error: "location is required" };
        const { results, fuzzy } = d.search(db, { q, limit: 5, sort: "relevance" });
        const hit = results.find((r) => (r as { lat?: number | null }).lat != null);
        if (!hit) return null;
        const s = toolAppSummary(hit as never);
        return {
          matched_address: s.address_text ?? s.planning_reference,
          lat: s.lat,
          lng: s.lng,
          authority_id: s.authority_id,
          confidence: fuzzy ? "approximate" : "exact",
        };
      }
      default:
        return { error: `Unknown tool: ${name}` };
    }
  };
}
