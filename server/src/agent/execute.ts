import type Database from "better-sqlite3";
import { search as realSearch } from "../search.js";
import { AGILE_CLIENT_BY_AUTHORITY, fetchAgileConditions } from "../agile.js";
import { fetchZoning } from "../zoning.js";
import { fetchFlood } from "../flood.js";
import { abpCaseUrl, fetchAppealCase } from "../abp.js";
import { deriveScannedFilesUrl, fetchScannedFileList } from "../documents.js";
import { STATUS_LABELS } from "../normalize.js";
import { searchFiltersFromToolInput } from "./tools.js";

export interface ToolDeps {
  search: typeof realSearch;
  fetchAgileConditions: typeof fetchAgileConditions;
  fetchZoning: typeof fetchZoning;
  fetchFlood: typeof fetchFlood;
  fetchAppealCase: typeof fetchAppealCase;
  fetchScannedFileList: typeof fetchScannedFileList;
}

const REAL_DEPS: ToolDeps = {
  search: realSearch,
  fetchAgileConditions,
  fetchZoning,
  fetchFlood,
  fetchAppealCase,
  fetchScannedFileList,
};

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
      case "search_applications": {
        const { results, total, fuzzy } = d.search(db, searchFiltersFromToolInput(input));
        return { total, fuzzy, results: results.map((r) => toolAppSummary(r as never)) };
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
      case "get_flood_risk": {
        const row = getRow(input);
        if (!row) return { error: "Application not found" };
        if (row.lat == null || row.lng == null) return { error: "Application has no coordinates" };
        return (await d.fetchFlood(Number(row.lat), Number(row.lng))) ?? { error: "Flood lookup failed" };
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
        if (!listUrl) return { error: "No document listing available for this council" };
        const files = await d.fetchScannedFileList(listUrl);
        if (!files) return { error: "Could not load the document list" };
        return { count: files.length, files: files.map((f) => ({ title: f.title })) };
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
