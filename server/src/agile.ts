/**
 * Agile Applications citizen-portal API (South Dublin, Dublin City, Fingal).
 *
 * The SPA's backing API is open but tenant-scoped via three headers
 * (x-client / x-product / x-service, captured from a real browser session).
 * GET /api/application/{id} returns rich detail including applicant and
 * agent names — both absent/redacted in the national dataset. The
 * /document endpoint exists but returns [] for the Irish councils, so file
 * listings still are not available this way.
 */
import type { EplanningParties } from "./documents.js";

const AGILE_API = "https://planningapi.agileapplications.ie/api";
const TIMEOUT_MS = 12_000;

export const AGILE_CLIENT_BY_AUTHORITY: Record<string, string> = {
  "south-dublin": "SD",
  "dublin-city": "DCC",
  fingal: "FG",
  dlr: "DLR",
};

function headers(client: string): Record<string, string> {
  return {
    "User-Agent": "PlanView/0.1 (planning register viewer; respectful on-demand fetch)",
    Accept: "application/json",
    "x-client": client,
    "x-product": "CITIZENPORTAL",
    "x-service": "PA",
  };
}

async function getJson(url: string, client: string): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal, headers: headers(client) });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Forename/surname pairs arrive in any mix; some rows put the full name in
 *  the surname field. */
function joinName(fore: unknown, sur: unknown, whole: unknown): string | null {
  const parts = [fore, sur].map((v) => String(v ?? "").trim()).filter(Boolean);
  if (parts.length) return parts.join(" ");
  const w = String(whole ?? "").trim();
  return w || null;
}

/**
 * Resolve the portal's internal application id: from a deep link when the
 * dataset has one, otherwise via the API's reference search (Dublin City
 * rows carry no links at all; Fingal's are truncated at source).
 */
const AGILE_ID_CACHE = new Map<string, string>();

async function resolveAgileId(
  client: string,
  sourceUrl: string | null,
  reference: string
): Promise<string | null> {
  const fromUrl = sourceUrl?.match(/application-details\/(\d+)/i)?.[1];
  if (fromUrl) return fromUrl;
  const cacheKey = `${client}:${reference}`;
  const cached = AGILE_ID_CACHE.get(cacheKey);
  if (cached) return cached;
  const found = (await getJson(
    `${AGILE_API}/application/search?query=${encodeURIComponent(reference)}`,
    client
  )) as { results?: Array<{ id: number; reference: string }> } | null;
  const hit = found?.results?.find(
    (r) => r.reference?.trim().toLowerCase() === reference.trim().toLowerCase()
  );
  if (hit) AGILE_ID_CACHE.set(cacheKey, String(hit.id));
  return hit ? String(hit.id) : null;
}

export interface ConditionItem {
  code: string;
  code_label: string;
  title: string;
  text: string;
  order: number;
}

export interface DecisionConditions {
  decision: string | null;
  decision_date: string | null;
  items: ConditionItem[];
}

/**
 * GET /application/{id}/conditions returns the full decision text plus
 * "prescriptions" — the substance of the decision, coded by kind:
 * C condition of grant, R reason for refusal, D directive (what an F.I.
 * request asked for), I informative, N note.
 */
export async function fetchAgileConditions(
  authorityId: string,
  sourceUrl: string | null,
  reference: string
): Promise<DecisionConditions | null> {
  const client = AGILE_CLIENT_BY_AUTHORITY[authorityId];
  if (!client) return null;
  const id = await resolveAgileId(client, sourceUrl, reference);
  if (!id) return null;
  const d = (await getJson(`${AGILE_API}/application/${id}/conditions`, client)) as {
    decisionText?: string | null;
    decisionDate?: string | null;
    applicationPrescriptions?: Array<{
      shortPrescription?: string | null;
      longPrescription?: string | null;
      prescriptionCode?: string | null;
      prescriptionCodeDescription?: string | null;
      orderNumber?: number | null;
    }>;
  } | null;
  if (!d || typeof d !== "object") return null;
  const items: ConditionItem[] = (d.applicationPrescriptions ?? [])
    .map((p) => ({
      code: String(p.prescriptionCode ?? "").trim(),
      code_label: String(p.prescriptionCodeDescription ?? "").trim(),
      title: String(p.shortPrescription ?? "").trim(),
      text: String(p.longPrescription ?? "").replace(/\r\n/g, "\n").trim(),
      order: Number(p.orderNumber ?? 0),
    }))
    .filter((p) => p.title || p.text)
    .sort((a, b) => a.code.localeCompare(b.code) || a.order - b.order);
  const decision = String(d.decisionText ?? "").trim() || null;
  if (!decision && items.length === 0) return null;
  return {
    decision,
    decision_date: d.decisionDate ? String(d.decisionDate).slice(0, 10) : null,
    items,
  };
}

export async function fetchAgileParties(
  authorityId: string,
  sourceUrl: string | null,
  reference: string
): Promise<EplanningParties> {
  const none: EplanningParties = { applicant: null, agent: null };
  const client = AGILE_CLIENT_BY_AUTHORITY[authorityId];
  if (!client) return none;
  const id = await resolveAgileId(client, sourceUrl, reference);
  if (!id) return none;
  const d = (await getJson(`${AGILE_API}/application/${id}`, client)) as Record<
    string,
    unknown
  > | null;
  if (!d || typeof d !== "object") return none;
  return {
    applicant: joinName(d.applicantForename, d.applicantSurname, d.applicantName),
    agent: joinName(d.agentForename, d.agentSurname, d.agentName),
  };
}

/* ------------------------------------------------------------------ */
/* Portal deep links and document listings                             */
/* ------------------------------------------------------------------ */

import {
  filenameFromDisposition,
  safeFilename,
  type DiagnosticStep,
  type FetchedDocument,
  type ScannedFile,
} from "./documents.js";

const AGILE_PORTAL = "https://planning.agileapplications.ie";

export const AGILE_SLUG_BY_AUTHORITY: Record<string, string> = {
  "south-dublin": "southdublin",
  "dublin-city": "dublincity",
  fingal: "fingal",
  dlr: "dunlaoghaire",
};

async function getJsonTraced(
  url: string,
  client: string,
  service: string,
  trace?: DiagnosticStep[]
): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { ...headers(client), "x-service": service },
    });
    const step: DiagnosticStep = {
      step: "agile_api",
      url: `${url} [x-service=${service}]`,
      status: res.status,
      contentType: res.headers.get("content-type") ?? undefined,
    };
    if (!res.ok) {
      trace?.push(step);
      return null;
    }
    const body = await res.json();
    step.bodySnippet = JSON.stringify(body).slice(0, 400);
    trace?.push(step);
    return body;
  } catch (err) {
    trace?.push({ step: "agile_api", url, error: String(err) });
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Deep link to the citizen portal's application page, via the verified API. */
export async function agilePortalUrl(
  authorityId: string,
  sourceUrl: string | null,
  reference: string,
  trace?: DiagnosticStep[]
): Promise<string | null> {
  const client = AGILE_CLIENT_BY_AUTHORITY[authorityId];
  const slug = AGILE_SLUG_BY_AUTHORITY[authorityId];
  if (!client || !slug) return null;
  const id = await resolveAgileId(client, sourceUrl, reference);
  trace?.push({ step: "agile_resolve", resolvedId: id === null ? null : Number(id) });
  return id ? `${AGILE_PORTAL}/${slug}/application-details/${id}` : null;
}

/** Deep link to the citizen portal's application page, via the verified API. */
const str = (v: unknown): string | null =>
  typeof v === "string" && v.trim().length > 0 ? v.trim() : null;

export interface AgileDocEntry {
  title: string;
  /** Raw filename from the API (carries the reliable extension). */
  name: string | null;
  /** Document's received date, DD/MM/YYYY, if the API provides one. */
  date: string | null;
  documentId: string | null;
  documentHash: string | null;
}

/** "2024-07-18T00:00:00" -> "18/07/2024" (Irish convention); null if unparseable. */
function formatAgileDate(raw: unknown): string | null {
  const s = typeof raw === "string" ? raw.slice(0, 10) : "";
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  return m ? `${m[3]}/${m[2]}/${m[1]}` : null;
}

/** Top-level array (or the first array inside a wrapper object) of documents. */
function coerceDocArray(json: unknown): Record<string, unknown>[] {
  if (Array.isArray(json)) return json as Record<string, unknown>[];
  if (json && typeof json === "object") {
    for (const v of Object.values(json)) {
      if (Array.isArray(v)) return v as Record<string, unknown>[];
    }
  }
  return [];
}

/**
 * The verified /api/application/{id}/document shape: a flat array of
 * { documentHash, documentId (string), name (raw filename), description /
 * mediaDescription (human title) }. Prefer the description as the title.
 */
export function parseAgileDocEntries(json: unknown): AgileDocEntry[] {
  return coerceDocArray(json)
    .map((o) => {
      const documentHash = str(o.documentHash);
      const documentId = str(o.documentId);
      if (!documentHash && !documentId) return null;
      const title = str(o.description) ?? str(o.mediaDescription) ?? str(o.name) ?? "Document";
      return {
        title,
        name: str(o.name),
        date: formatAgileDate(o.receivedDate),
        documentId,
        documentHash,
      };
    })
    .filter((x): x is AgileDocEntry => x !== null);
}

/** ScannedFile view for the list UI (url is a stable placeholder — the file
 *  itself is streamed by index through our proxy, which adds tenant headers). */
export function parseAgileDocuments(json: unknown): ScannedFile[] {
  return parseAgileDocEntries(json).map((e) => ({
    title: e.date ? `${e.title} — ${e.date}` : e.title,
    url: `${AGILE_API}/document/${e.documentHash ?? e.documentId}`,
  }));
}

/**
 * Download URLs for one document. The verified pattern (captured from the
 * portal) is /api/application/document/{documentHash}; the rest are defensive
 * fallbacks.
 */
export function agileDownloadCandidates(entry: AgileDocEntry, appId: string): string[] {
  const urls: string[] = [];
  if (entry.documentHash) {
    urls.push(`${AGILE_API}/application/document/${entry.documentHash}`);
    urls.push(`${AGILE_API}/document/${entry.documentHash}`);
  }
  if (entry.documentId) {
    urls.push(`${AGILE_API}/application/document/${entry.documentId}`);
  }
  return urls;
}

const CONFIRMED_DOC_ENDPOINT = (id: string) => `${AGILE_API}/application/${id}/document`;

/**
 * List an application's documents via the verified endpoint. Returns the
 * portal deep link even when the endpoint yields nothing, so the UI can
 * always land users one click away.
 */
export async function fetchAgileDocumentList(
  authorityId: string,
  sourceUrl: string | null,
  reference: string,
  trace?: DiagnosticStep[]
): Promise<{ files: ScannedFile[]; applicationUrl: string } | null> {
  const client = AGILE_CLIENT_BY_AUTHORITY[authorityId];
  const slug = AGILE_SLUG_BY_AUTHORITY[authorityId];
  if (!client || !slug) return null;
  const id = await resolveAgileId(client, sourceUrl, reference);
  trace?.push({ step: "agile_resolve", resolvedId: id === null ? null : Number(id) });
  if (!id) return null;
  const applicationUrl = `${AGILE_PORTAL}/${slug}/application-details/${id}`;
  const json = await getJsonTraced(CONFIRMED_DOC_ENDPOINT(id), client, "PA", trace);
  const files = parseAgileDocuments(json);
  trace?.push({ step: "agile_documents", url: CONFIRMED_DOC_ENDPOINT(id), fileCount: files.length });
  return { files, applicationUrl };
}

/** A friendly filename: the human title with the raw file's extension. */
function agileFilename(entry: AgileDocEntry): string | null {
  const ext = entry.name?.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1];
  const base = safeFilename(entry.title);
  return ext ? `${base}.${ext}` : entry.name ?? (base || null);
}

/**
 * Stream one Agile document by its position in the list, adding the tenant
 * headers a plain browser navigation can't. Re-fetches the (stably ordered)
 * document list, then tries the candidate download URLs for that entry until
 * one returns non-JSON bytes. "too_large" for anything over the serverless
 * response limit; null on any failure.
 */
export async function fetchAgileDocument(
  authorityId: string,
  sourceUrl: string | null,
  reference: string,
  index: number,
  maxBytes = 4_000_000,
  trace?: DiagnosticStep[]
): Promise<FetchedDocument | "too_large" | null> {
  const client = AGILE_CLIENT_BY_AUTHORITY[authorityId];
  if (!client) return null;
  const id = await resolveAgileId(client, sourceUrl, reference);
  if (!id) return null;
  const listJson = await getJsonTraced(CONFIRMED_DOC_ENDPOINT(id), client, "PA", trace);
  const entries = parseAgileDocEntries(listJson);
  const target = entries[index];
  if (!target) {
    trace?.push({ step: "agile_target", error: `No document at index ${index} of ${entries.length}` });
    return null;
  }
  for (const url of agileDownloadCandidates(target, id)) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 25_000);
    try {
      const res = await fetch(url, {
        signal: controller.signal,
        headers: { ...headers(client), Accept: "application/pdf,application/octet-stream,*/*" },
      });
      const ct = res.headers.get("content-type") ?? "application/octet-stream";
      trace?.push({ step: "agile_download", url, status: res.status, contentType: ct });
      if (!res.ok || /application\/json|text\/html/i.test(ct)) continue;
      const declared = Number(res.headers.get("content-length"));
      if (Number.isFinite(declared) && declared > maxBytes) return "too_large";
      const body = Buffer.from(await res.arrayBuffer());
      if (body.byteLength > maxBytes) return "too_large";
      return {
        contentType: ct,
        filename: filenameFromDisposition(res.headers.get("content-disposition")) ?? agileFilename(target),
        body,
      };
    } catch (err) {
      trace?.push({ step: "agile_download", url, error: String(err) });
    } finally {
      clearTimeout(timer);
    }
  }
  return null;
}
