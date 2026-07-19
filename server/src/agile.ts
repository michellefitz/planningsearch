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
async function resolveAgileId(
  client: string,
  sourceUrl: string | null,
  reference: string
): Promise<string | null> {
  const fromUrl = sourceUrl?.match(/application-details\/(\d+)/i)?.[1];
  if (fromUrl) return fromUrl;
  const found = (await getJson(
    `${AGILE_API}/application/search?query=${encodeURIComponent(reference)}`,
    client
  )) as { results?: Array<{ id: number; reference: string }> } | null;
  const hit = found?.results?.find(
    (r) => r.reference?.trim().toLowerCase() === reference.trim().toLowerCase()
  );
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
