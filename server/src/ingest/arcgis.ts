/**
 * Ingestion from the National Planning Applications ArcGIS Feature Service
 * (DHLGH, CC-BY 4.0) — PRD §5.1/§7.2. Metadata only; documents stay on the
 * council portals (§7.3).
 *
 * NOTE: field names below follow the published national layer but could not be
 * verified from the build sandbox (arcgis.com is not reachable through its
 * network policy). `FIELD_MAP` centralises them: run
 * `curl "<SERVICE_URL>/0?f=json" | jq '.fields[].name'` once against the live
 * service and adjust in one place if anything differs.
 */
import {
  authorityIdForNationalName,
  AUTHORITIES,
  AUTHORITY_BY_ID,
} from "../config/authorities.js";
import {
  deriveApplicationType,
  extractResidentialUnits,
  guessIsDomestic,
  normalizeStatus,
} from "../normalize.js";
import { extractEircode } from "./ppr.js";
import { mapPool } from "./pool.js";
import type { ApplicationRecord } from "../db.js";

/** Feature pages fetched in parallel once the total count is known. */
const PAGE_CONCURRENCY = 6;

export const SERVICE_URL =
  process.env.PLANVIEW_ARCGIS_URL ??
  "https://services.arcgis.com/NzlPQPKn5QF9v2US/arcgis/rest/services/IrishPlanningApplications/FeatureServer/0";

// Verified against the live service schema on 2026-07-18.
export const FIELD_MAP = {
  authority: "PlanningAuthority",
  reference: "ApplicationNumber",
  description: "DevelopmentDescription",
  address: "DevelopmentAddress",
  applicationType: "ApplicationType",
  status: "ApplicationStatus",
  received: "ReceivedDate",
  withdrawn: "WithdrawnDate",
  decision: "Decision",
  decisionDate: "DecisionDate",
  decisionDueDate: "DecisionDueDate",
  fiRequested: "FIRequestDate",
  fiReceived: "FIRecDate",
  grantDate: "GrantDate",
  appealStatus: "AppealStatus",
  appealReference: "AppealRefNumber",
  appealLodged: "AppealSubmittedDate",
  appealDecision: "AppealDecision",
  appealDecisionDate: "AppealDecisionDate",
  applicant: "ApplicantForename", // often null (redacted at source); see buildApplicantName
  applicantSurname: "ApplicantSurname",
  eircode: "DevelopmentPostcode",
  oneOffHouse: "OneOffHouse",
  link: "LinkAppDetails",
  numResidentialUnits: "NumResidentialUnits",
  floorArea: "FloorArea",
  siteArea: "AreaofSite",
  expiryDate: "ExpiryDate",
} as const;

type Attributes = Record<string, unknown>;

export interface ArcgisFeature {
  attributes: Attributes;
  geometry?: { x?: number; y?: number; rings?: number[][][] };
}

function str(attrs: Attributes, field: string): string | null {
  const v = attrs[field];
  if (v == null) return null;
  const s = String(v).trim();
  return s.length ? s : null;
}

function num(attrs: Attributes, field: string): number | null {
  const v = attrs[field];
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** ArcGIS dates are epoch millis; normalise to YYYY-MM-DD. */
function isoDate(attrs: Attributes, field: string): string | null {
  const v = attrs[field];
  if (v == null || v === "") return null;
  const n = typeof v === "number" ? v : Date.parse(String(v));
  if (!Number.isFinite(n)) return null;
  return new Date(n).toISOString().slice(0, 10);
}

function buildApplicantName(attrs: Attributes): string | null {
  const fore = str(attrs, FIELD_MAP.applicant);
  const sur = str(attrs, FIELD_MAP.applicantSurname);
  const joined = [fore, sur].filter(Boolean).join(" ").trim();
  return joined.length ? joined : null;
}

/** Map one ArcGIS feature onto the canonical record; null if unmappable. */
export function featureToRecord(
  feature: ArcgisFeature,
  now: string = new Date().toISOString()
): ApplicationRecord | null {
  const attrs = feature.attributes;
  const authorityName = str(attrs, FIELD_MAP.authority);
  const reference = str(attrs, FIELD_MAP.reference);
  if (!authorityName || !reference) return null;
  const authorityId = authorityIdForNationalName(authorityName);
  if (!authorityId) return null; // outside the five v1 authorities

  const description = str(attrs, FIELD_MAP.description);
  const statusRaw = str(attrs, FIELD_MAP.status);
  const decisionRaw = str(attrs, FIELD_MAP.decision);
  const typeRaw = str(attrs, FIELD_MAP.applicationType);

  let lat: number | null = null;
  let lng: number | null = null;
  if (feature.geometry && typeof feature.geometry.x === "number" && typeof feature.geometry.y === "number") {
    // Service is requested with outSR=4326, so x/y are lng/lat.
    lng = feature.geometry.x;
    lat = feature.geometry.y;
    const auth = AUTHORITY_BY_ID.get(authorityId)!;
    const [w, s, e, n] = auth.bbox;
    // Drop clearly-wrong geometry (projection mishaps) rather than plotting it.
    if (lng < w - 0.5 || lng > e + 0.5 || lat < s - 0.5 || lat > n + 0.5) {
      lat = null;
      lng = null;
    }
  }

  const auth = AUTHORITY_BY_ID.get(authorityId)!;
  // Two classes of unusable LinkAppDetails for Agile-hosted councils:
  // truncated agile URLs (Fingal's cut off at ~50 chars → 404), and links to
  // retired portals (South Dublin pre-migration). Both fall back to the
  // portal search URL; a click-time resolver upgrades it to a deep link.
  let link = str(attrs, FIELD_MAP.link);
  if (auth.sourceSystem === "agile" && link) {
    const usableAgile =
      /agileapplications\.ie/i.test(link) && /application-details\/\d+/i.test(link);
    if (!usableAgile) link = null;
  }
  const sourceUrl = link ?? auth.portalUrlForReference(reference);

  // The dataset's own one-off-house flag is a strong domestic signal on top
  // of the description heuristic.
  const oneOff = /^y(es)?$/i.test(str(attrs, FIELD_MAP.oneOffHouse) ?? "");
  const withdrawnDate = isoDate(attrs, FIELD_MAP.withdrawn);
  // A decided appeal supersedes the council's decision (An Bord Pleanála's
  // outcome is the operative one) — but only when it's a clear grant/refuse.
  // Outcomes like "MODIFIED" or "CONDITIONS VARIED" just alter the conditions
  // of the council's grant, so the council's decision still stands; falling
  // back to it avoids an appealed-and-granted case reading as "unknown".
  const appealDecision = str(attrs, FIELD_MAP.appealDecision);
  const grantDate = isoDate(attrs, FIELD_MAP.grantDate);
  let councilStatus = normalizeStatus(statusRaw, decisionRaw);
  // A final grant only issues after a grant decision. When the status/decision
  // text didn't resolve (national fields blank or truncated) but a grant date
  // is on record, it's granted — this keeps decided permissions off the map's
  // "unknown" pin without needing a live portal read.
  if ((councilStatus === "unknown" || councilStatus === "pending") && grantDate) {
    councilStatus = "granted";
  }
  const appealStatus = appealDecision ? normalizeStatus("decided", appealDecision) : null;

  return {
    authority_id: authorityId,
    planning_reference: reference,
    description,
    // National ApplicationType is sparse; fall back to the description so
    // retention (a materially different thing to compare against ordinary
    // permission) is separated out even when the type field is blank.
    application_type: deriveApplicationType(typeRaw, description),
    application_type_raw: typeRaw,
    is_domestic_guess: oneOff || guessIsDomestic(description) ? 1 : 0,
    status: withdrawnDate
      ? "withdrawn"
      : appealStatus && appealStatus !== "unknown"
        ? appealStatus
        : councilStatus,
    status_raw: statusRaw,
    received_date: isoDate(attrs, FIELD_MAP.received),
    validated_date: null,
    further_info_requested_date: isoDate(attrs, FIELD_MAP.fiRequested),
    further_info_received_date: isoDate(attrs, FIELD_MAP.fiReceived),
    decision_due_date: isoDate(attrs, FIELD_MAP.decisionDueDate),
    // The national feed carries no submissions deadline.
    submissions_by_date: null,
    decision: decisionRaw,
    decision_raw: decisionRaw,
    decision_date: isoDate(attrs, FIELD_MAP.decisionDate),
    appeal_status: str(attrs, FIELD_MAP.appealStatus),
    appeal_reference: str(attrs, FIELD_MAP.appealReference),
    appeal_lodged_date: isoDate(attrs, FIELD_MAP.appealLodged),
    appeal_decision: appealDecision,
    appeal_decision_date: isoDate(attrs, FIELD_MAP.appealDecisionDate),
    final_grant_date: grantDate,
    applicant_name: buildApplicantName(attrs),
    agent_name: null,
    address_text: str(attrs, FIELD_MAP.address),
    // The national DevelopmentPostcode is ~2% filled (and sometimes junk like
    // "2."), but many addresses embed the Eircode — pull a validated one from
    // the postcode field, else the address, else the description.
    eircode:
      extractEircode(str(attrs, FIELD_MAP.eircode)) ??
      extractEircode(str(attrs, FIELD_MAP.address)) ??
      extractEircode(description),
    // The feed's field wins when present — where they disagree it's usually an
    // amendment whose description cites the parent scheme's unit count.
    num_residential_units:
      num(attrs, FIELD_MAP.numResidentialUnits) ?? extractResidentialUnits(description),
    floor_area_sqm: num(attrs, FIELD_MAP.floorArea),
    site_area_ha: num(attrs, FIELD_MAP.siteArea),
    expiry_date: isoDate(attrs, FIELD_MAP.expiryDate),
    lat,
    lng,
    geom_polygon: null,
    source_url: sourceUrl,
    last_synced: now,
  };
}

export interface FetchPageOptions {
  where: string;
  offset: number;
  pageSize: number;
  signal?: AbortSignal;
}

/** Total matching features, so pages can be fetched in parallel rather than
 *  discovered one at a time. Null if the service won't answer a count query. */
export async function fetchCount(where: string): Promise<number | null> {
  const params = new URLSearchParams({ f: "json", where, returnCountOnly: "true" });
  try {
    const res = await fetch(`${SERVICE_URL}/query?${params}`);
    if (!res.ok) return null;
    const body = (await res.json()) as { count?: number };
    return typeof body.count === "number" ? body.count : null;
  } catch {
    return null;
  }
}

export async function fetchPage(opts: FetchPageOptions): Promise<ArcgisFeature[]> {
  const params = new URLSearchParams({
    f: "json",
    where: opts.where,
    outFields: "*",
    outSR: "4326",
    resultOffset: String(opts.offset),
    resultRecordCount: String(opts.pageSize),
    orderByFields: "OBJECTID",
  });
  const res = await fetch(`${SERVICE_URL}/query?${params}`, { signal: opts.signal });
  if (!res.ok) throw new Error(`ArcGIS query failed: HTTP ${res.status}`);
  const body = (await res.json()) as { features?: ArcgisFeature[]; error?: { message?: string } };
  if (body.error) throw new Error(`ArcGIS query error: ${body.error.message ?? "unknown"}`);
  return body.features ?? [];
}

/**
 * WHERE clause selecting the five v1 authorities, optionally since a date.
 * Uses LIKE fragments rather than exact names because the source is not
 * consistent about accents/hyphens (e.g. Dún Laoghaire-Rathdown).
 */
export function buildWhereClause(sinceIso?: string): string {
  const likes = AUTHORITIES.map(
    (a) => `${FIELD_MAP.authority} LIKE '%${a.nationalDbLike.replace(/'/g, "''")}%'`
  );
  const authorityClause = `(${likes.join(" OR ")})`;
  if (!sinceIso) return authorityClause;
  return `${authorityClause} AND ${FIELD_MAP.received} >= TIMESTAMP '${sinceIso} 00:00:00'`;
}

/** One page with a couple of retries — the public service occasionally blips. */
async function fetchPageWithRetry(
  where: string,
  offset: number,
  pageSize: number
): Promise<ArcgisFeature[]> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fetchPage({ where, offset, pageSize });
    } catch (err) {
      if (attempt === 3) throw err;
      await new Promise((r) => setTimeout(r, attempt * 2000));
    }
  }
}

/**
 * Fetch every matching feature since a date.
 *
 * Asking for the count first turns pagination from a serial walk (fetch a page,
 * discover whether there's another, repeat) into a set of known offsets we can
 * pull a few at a time — the single biggest chunk of build time. Ordering by
 * OBJECTID keeps the offsets stable across requests. Falls back to the serial
 * walk if the service won't give a count.
 */
export async function fetchAllSince(
  sinceIso: string,
  onPage?: (fetched: number) => void
): Promise<ArcgisFeature[]> {
  const where = buildWhereClause(sinceIso);
  const pageSize = 1000;
  const total = await fetchCount(where);

  if (total != null) {
    const offsets: number[] = [];
    for (let o = 0; o < total; o += pageSize) offsets.push(o);
    let done = 0;
    const pages = await mapPool(offsets, PAGE_CONCURRENCY, async (offset) => {
      const features = await fetchPageWithRetry(where, offset, pageSize);
      done += features.length;
      onPage?.(done);
      return features;
    });
    return pages.flat();
  }

  // No count available — walk the pages in order until one comes up short.
  const all: ArcgisFeature[] = [];
  for (let offset = 0; ; offset += pageSize) {
    const features = await fetchPageWithRetry(where, offset, pageSize);
    all.push(...features);
    onPage?.(all.length);
    if (features.length < pageSize) break;
  }
  return all;
}
