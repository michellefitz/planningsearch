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
  isOneOffHouse,
  normalizeStatus,
  ONE_OFF_HOUSE_FLAG_RE,
  realDecision,
} from "../normalize.js";
import { extractEircode } from "./ppr.js";
import {
  multiPolygonAreaSqm,
  ringsToMultiPolygon,
  simplifyMultiPolygon,
} from "./geom.js";
import { mapPool } from "./pool.js";
import type { ApplicationRecord } from "../db.js";

/** Feature pages fetched in parallel once the total count is known. */
const PAGE_CONCURRENCY = 6;

export const SERVICE_URL =
  process.env.PLANVIEW_ARCGIS_URL ??
  "https://services.arcgis.com/NzlPQPKn5QF9v2US/arcgis/rest/services/IrishPlanningApplications/FeatureServer/0";

/**
 * Layer 1 of the same feature service, "Planning Application Sites" — the site
 * boundary for each application, as a polygon. Layer 0 ("Planning Application
 * Points") carries only a centroid, which is why site outlines used to come
 * from the commission's case service alone.
 *
 * Coverage is effectively 1:1 with the points, verified against the live
 * service on 2026-07-30: 500,559 sites against 500,736 points nationally,
 * 94,380 against 94,303 for the five authorities since 2012, 438 against 438
 * for applications received in the last 30 days, and the same max ETL_DATE.
 * Every year back to 2012 matches, so this is not a stale one-off load.
 */
export const SITES_URL =
  process.env.PLANVIEW_ARCGIS_SITES_URL ?? SERVICE_URL.replace(/\/0$/, "/1");

/** Site boundaries are simplified to this tolerance before being stored —
 *  visually exact at any zoom the map offers, and half the bytes. Areas are
 *  measured before simplifying (it distorts small sites by up to 52%). */
const SITE_SIMPLIFY_M = 2;

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
  // Each council writes this flag in its own words. Counted against the live
  // feed: South Dublin "Yes" (33,106 rows, the only one that fills it for
  // every application), Kildare "One" (3,098), Fingal "Single House" (2,508,
  // space-padded), and Dublin City and DLR never populate it at all. Matching
  // only Y/Yes — as this did — silently dropped Kildare's and Fingal's,
  // leaving those two to the description heuristic alone.
  const oneOff = ONE_OFF_HOUSE_FLAG_RE.test(str(attrs, FIELD_MAP.oneOffHouse) ?? "");
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
    is_one_off: isOneOffHouse(description, str(attrs, FIELD_MAP.oneOffHouse)) ? 1 : 0,
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
    // The register's decision column doubles as a progress log, so it can hold
    // "N/A" or "Request Additional Information" on an application nobody has
    // decided. decision_raw keeps whatever it said; decision carries only an
    // actual outcome, so nothing downstream has to second-guess it.
    decision: realDecision(decisionRaw),
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
    // AreaofSite is deliberately NOT read here: councils publish it in
    // different units. Measured against true geometry for 300 sites each,
    // Dublin City, Fingal, DLR and South Dublin give square metres while
    // Kildare gives hectares — so reading it as hectares (as this did) made
    // four of the five authorities 10,000x too large. The honest value is the
    // area of the site boundary, which fetchAllSites measures; applications
    // with no boundary get null rather than a number in unknown units.
    site_area_ha: null,
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
  /** Layer to query; defaults to the points layer. */
  serviceUrl?: string;
  /** Fields to return; defaults to everything. */
  outFields?: string;
}

/** Total matching features, so pages can be fetched in parallel rather than
 *  discovered one at a time. Null if the service won't answer a count query. */
export async function fetchCount(
  where: string,
  serviceUrl: string = SERVICE_URL
): Promise<number | null> {
  const params = new URLSearchParams({ f: "json", where, returnCountOnly: "true" });
  try {
    const res = await fetch(`${serviceUrl}/query?${params}`);
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
    outFields: opts.outFields ?? "*",
    outSR: "4326",
    resultOffset: String(opts.offset),
    resultRecordCount: String(opts.pageSize),
    orderByFields: "OBJECTID",
  });
  const res = await fetch(`${opts.serviceUrl ?? SERVICE_URL}/query?${params}`, { signal: opts.signal });
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
  const likes = AUTHORITIES.map((a) => {
    const esc = (v: string) => v.replace(/'/g, "''");
    let clause = `${FIELD_MAP.authority} LIKE '%${esc(a.nationalDbLike)}%'`;
    // LIKE has no word boundaries: "%Meath%" also matches Westmeath.
    for (const not of a.nationalDbNotLike ?? []) {
      clause += ` AND ${FIELD_MAP.authority} NOT LIKE '%${esc(not)}%'`;
    }
    return a.nationalDbNotLike?.length ? `(${clause})` : clause;
  });
  const authorityClause = `(${likes.join(" OR ")})`;
  if (!sinceIso) return authorityClause;
  return `${authorityClause} AND ${FIELD_MAP.received} >= TIMESTAMP '${sinceIso} 00:00:00'`;
}

/** One page with a couple of retries — the public service occasionally blips. */
async function fetchPageWithRetry(
  where: string,
  offset: number,
  pageSize: number,
  serviceUrl?: string,
  outFields?: string
): Promise<ArcgisFeature[]> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fetchPage({ where, offset, pageSize, serviceUrl, outFields });
    } catch (err) {
      if (attempt === 3) throw err;
      await new Promise((r) => setTimeout(r, attempt * 2000));
    }
  }
}

/**
 * Fetch every feature matching a WHERE clause from one layer.
 *
 * Asking for the count first turns pagination from a serial walk (fetch a page,
 * discover whether there's another, repeat) into a set of known offsets we can
 * pull a few at a time — the single biggest chunk of build time. Ordering by
 * OBJECTID keeps the offsets stable across requests. Falls back to the serial
 * walk if the service won't give a count.
 */
async function fetchAllPages(
  where: string,
  onPage?: (fetched: number) => void,
  serviceUrl?: string,
  outFields?: string
): Promise<ArcgisFeature[]> {
  const pageSize = 1000;
  const total = await fetchCount(where, serviceUrl ?? SERVICE_URL);

  if (total != null) {
    const offsets: number[] = [];
    for (let o = 0; o < total; o += pageSize) offsets.push(o);
    let done = 0;
    const pages = await mapPool(offsets, PAGE_CONCURRENCY, async (offset) => {
      const features = await fetchPageWithRetry(where, offset, pageSize, serviceUrl, outFields);
      done += features.length;
      onPage?.(done);
      return features;
    });
    return pages.flat();
  }

  // No count available — walk the pages in order until one comes up short.
  const all: ArcgisFeature[] = [];
  for (let offset = 0; ; offset += pageSize) {
    const features = await fetchPageWithRetry(where, offset, pageSize, serviceUrl, outFields);
    all.push(...features);
    onPage?.(all.length);
    if (features.length < pageSize) break;
  }
  return all;
}

/** Fetch every application (points layer) received since a date. */
export async function fetchAllSince(
  sinceIso: string,
  onPage?: (fetched: number) => void
): Promise<ArcgisFeature[]> {
  return fetchAllPages(buildWhereClause(sinceIso), onPage);
}

export interface SiteBoundary {
  /** GeoJSON MultiPolygon, stringified for the geom_polygon column. */
  geomPolygon: string;
  /** Ground area of the boundary in hectares — see site_area_ha above. */
  siteAreaHa: number | null;
}

/** Key a site onto its application: authority id + planning reference. */
export function siteKey(authorityId: string, reference: string): string {
  return `${authorityId}|${reference}`;
}

/**
 * Fetch the site boundary for every application received since a date, keyed by
 * `siteKey`. Geometry is requested at full precision so the area can be
 * measured honestly, then simplified for storage.
 *
 * Best-effort per feature: a site whose authority is outside the five, whose
 * reference is missing, or whose rings are degenerate is skipped rather than
 * failing the pull.
 */
export async function fetchAllSites(
  sinceIso: string,
  onPage?: (fetched: number) => void
): Promise<Map<string, SiteBoundary>> {
  const features = await fetchAllPages(
    buildWhereClause(sinceIso),
    onPage,
    SITES_URL,
    // Everything else about the application already comes from the points
    // layer; asking for all fields here would double the download for nothing.
    `${FIELD_MAP.authority},${FIELD_MAP.reference}`
  );

  const sites = new Map<string, SiteBoundary>();
  for (const f of features) {
    const authorityName = str(f.attributes, FIELD_MAP.authority);
    const reference = str(f.attributes, FIELD_MAP.reference);
    if (!authorityName || !reference || !f.geometry?.rings) continue;
    const authorityId = authorityIdForNationalName(authorityName);
    if (!authorityId) continue;

    const full = ringsToMultiPolygon(f.geometry.rings);
    if (!full) continue;
    const areaSqm = multiPolygonAreaSqm(full);
    const shown = simplifyMultiPolygon(full, SITE_SIMPLIFY_M) ?? full;
    sites.set(siteKey(authorityId, reference), {
      geomPolygon: JSON.stringify({ type: "MultiPolygon", coordinates: shown }),
      // Round to 4 dp (1 m² in hectares) — a back garden is ~0.03 ha, so
      // fewer places would collapse ordinary sites to zero.
      siteAreaHa: areaSqm > 0 ? Math.round((areaSqm / 10_000) * 1e4) / 1e4 : null,
    });
  }
  return sites;
}
