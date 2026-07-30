/**
 * Direct applications to An Coimisiún Pleanála (formerly An Bord Pleanála):
 * SHD, strategic infrastructure and substitute consent cases that never pass
 * through a council register, so the national DHLGH feed doesn't carry them.
 * This is where most 100+-home schemes lived between 2017 and 2022.
 *
 * Source: the commission's own ArcGIS service (CC-BY 4.0, actively updated),
 * with case polygons — centroids come free, no geocoding. Unit counts and
 * commencement data for SHD cases come from the DHLGH SHD tracker table,
 * joined on the 6-digit case id.
 */
import { extractResidentialUnits, normalizeStatus } from "../normalize.js";
import type { ApplicationRecord } from "../db.js";
import type { CanonicalApplicationType, CanonicalStatus } from "../normalize.js";

export const ACP_CASES_URL =
  "https://services-eu1.arcgis.com/o56BSnENmD5mYs3j/arcgis/rest/services/Cases_2016_Onwards/FeatureServer/3";
export const SHD_STATS_URL =
  "https://services.arcgis.com/NzlPQPKn5QF9v2US/arcgis/rest/services/SHD_ABP_Stats/FeatureServer/0";

/** Bundle authority entry for the commission — not a council, but it decides
 *  these cases, so it takes the authority slot the UI already understands. */
export const ACP_AUTHORITY = {
  id: "acp",
  name: "An Coimisiún Pleanála (direct applications)",
  short_name: "An Coimisiún Pleanála",
  source_system: "pleanala",
  portal_base_url: "https://www.pleanala.ie",
  gis_url: null,
} as const;

// Development-consent categories only. Appeals are ingested separately via
// council records; "LAP SID" cases are procedural leave-to-appeal requests,
// not applications for development.
const CATEGORIES = [
  "Housing",
  "Strategic Housing Dev",
  "SID (Not incl LAP SID cases)",
  "Strategic Infrastructure Dev",
  "Substitute Consent",
  "Quarry / Substitute Consent",
];

// PLANINGATY values used by the ACP service for the five covered authorities.
const PLANNING_AUTHORITIES = [
  "Dublin City Council",
  "Dun Laoghaire-Rathdown County Council",
  "Fingal County Council",
  "South Dublin County Council",
  "Kildare County Council",
];

function typeForCategory(category: string): CanonicalApplicationType {
  // Substitute consent is retrospective consent for EIA development —
  // materially the board's analogue of retention.
  if (/substitute/i.test(category)) return "retention";
  return "strategic";
}

/**
 * The DECISION field mixes real outcomes with progress notes ("Case is due to
 * be decided by 03/07/2024") and post-decision litigation states. Progress
 * notes are pending — they are not a decision and must not surface as one.
 */
export function acpDecisionToStatus(decision: string | null | undefined): CanonicalStatus {
  const d = `${decision ?? ""}`.trim();
  if (
    !d ||
    /^case is due to be decided|proposed decision date|consultations closed|further consideration/i.test(d)
  ) {
    return "pending";
  }
  // A quashed/annulled decision has no operative outcome any more, but the
  // case isn't live before the board either — surface as decided with the raw
  // text alongside.
  if (/quash|annull|please see case|alter decision/i.test(d)) return "decided";
  if (/make .*order/i.test(d)) return "granted";
  // Before the shared normaliser: it reads any refuse+approve pairing as a
  // split decision, but "Refuse to Approve" is a plain refusal.
  if (/refuse to approve/i.test(d)) return "refused";
  if (/part/i.test(d) && /grant|approve/i.test(d)) return "split";
  return normalizeStatus("decided", d);
}

function epochToIso(v: unknown): string | null {
  return typeof v === "number" && v > 0 ? new Date(v).toISOString().slice(0, 10) : null;
}

function quoteList(values: string[]): string {
  return values.map((v) => `'${v.replace(/'/g, "''")}'`).join(",");
}

interface AcpFeature {
  attributes: Record<string, unknown>;
  centroid?: { x: number; y: number };
  geometry?: { rings?: number[][][] };
}

/** Signed ring area (shoelace) — ArcGIS outer rings are clockwise (negative). */
function ringArea(ring: number[][]): number {
  let sum = 0;
  for (let i = 0; i < ring.length - 1; i++) {
    sum += ring[i][0] * ring[i + 1][1] - ring[i + 1][0] * ring[i][1];
  }
  return sum / 2;
}

/**
 * ArcGIS rings → GeoJSON MultiPolygon coordinates. ArcGIS mixes outer rings
 * (clockwise) and holes (counter-clockwise) in one flat list; each outer ring
 * starts a polygon and following holes attach to it.
 */
export function ringsToMultiPolygon(rings: number[][][]): number[][][][] | null {
  const polys: number[][][][] = [];
  for (const raw of rings) {
    if (raw.length < 4) continue;
    // 6 dp ≈ 0.1 m — full-precision doubles double the baked size for nothing.
    const ring = raw.map(([x, y]) => [Math.round(x * 1e6) / 1e6, Math.round(y * 1e6) / 1e6]);
    if (ringArea(ring) <= 0 || polys.length === 0) polys.push([ring]);
    else polys[polys.length - 1].push(ring);
  }
  return polys.length ? polys : null;
}

async function fetchJson(url: string): Promise<any> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`ACP fetch: HTTP ${res.status} for ${url}`);
  const body = await res.json();
  if (body.error) throw new Error(`ACP fetch: ${JSON.stringify(body.error)}`);
  return body;
}

async function fetchDirectCases(log: (msg: string) => void): Promise<AcpFeature[]> {
  const where = `CATEGORY IN (${quoteList(CATEGORIES)}) AND PLANINGATY IN (${quoteList(PLANNING_AUTHORITIES)})`;
  const features: AcpFeature[] = [];
  const pageSize = 1000;
  for (let offset = 0; ; offset += pageSize) {
    const params = new URLSearchParams({
      f: "json",
      where,
      outFields: "*",
      returnGeometry: "true",
      returnCentroid: "true",
      outSR: "4326",
      // ~2 m simplification: site boundaries stay visually exact at any zoom
      // the map offers while the baked polygons stay small.
      maxAllowableOffset: "0.00002",
      orderByFields: "OBJECTID",
      resultOffset: String(offset),
      resultRecordCount: String(pageSize),
    });
    const body = await fetchJson(`${ACP_CASES_URL}/query?${params}`);
    const page: AcpFeature[] = body.features ?? [];
    features.push(...page);
    log(`  ACP cases: fetched ${features.length}…`);
    if (page.length < pageSize) break;
  }
  return features;
}

export interface ShdStatsRow {
  units: number | null;
  commencementDate: string | null;
}

/** DD/MM/YYYY (as the tracker stores dates) → ISO, null if unparseable. */
function dmyToIso(v: unknown): string | null {
  const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(`${v ?? ""}`.trim());
  return m ? `${m[3]}-${m[2]}-${m[1]}` : null;
}

async function fetchShdStats(log: (msg: string) => void): Promise<Map<string, ShdStatsRow>> {
  const params = new URLSearchParams({
    f: "json",
    where: "1=1",
    outFields: "AppRef,Total_Resi,CommenceDate",
    returnGeometry: "false",
    resultRecordCount: "2000",
  });
  const body = await fetchJson(`${SHD_STATS_URL}/query?${params}`);
  const map = new Map<string, ShdStatsRow>();
  for (const f of body.features ?? []) {
    const a = f.attributes ?? {};
    // AppRef is usually the bare 6-digit case id, occasionally an old-format
    // "TA0001" — join on the 6-digit id where present.
    const id = /(\d{6})/.exec(`${a.AppRef ?? ""}`)?.[1];
    if (!id) continue;
    const units = typeof a.Total_Resi === "number" && a.Total_Resi > 0 ? a.Total_Resi : null;
    map.set(id, { units, commencementDate: dmyToIso(a.CommenceDate) });
  }
  log(`  SHD tracker: ${map.size} joinable rows.`);
  return map;
}

/**
 * All direct development-consent cases before the commission for the five
 * covered authorities, mapped onto ApplicationRecord under the "acp"
 * pseudo-authority. `commencementByRef` carries the SHD tracker's
 * commencement dates (keyed by planning_reference) — commencement lives on
 * the bundled app, not ApplicationRecord, so the caller applies it. Throws on
 * failure — callers treat it as best-effort.
 */
export async function fetchAcpDirectRecords(
  now: string,
  log: (msg: string) => void = () => {}
): Promise<{ records: ApplicationRecord[]; commencementByRef: Map<string, string> }> {
  const [features, shd] = await Promise.all([fetchDirectCases(log), fetchShdStats(log)]);
  const records: ApplicationRecord[] = [];
  const commencementByRef = new Map<string, string>();
  const seen = new Set<string>();
  for (const f of features) {
    const a = f.attributes;
    const caseId = `${a.ABPCASEID ?? ""}`.trim();
    if (!caseId || seen.has(caseId)) continue;
    seen.add(caseId);
    const description = `${a.DEVDESC ?? ""}`.trim() || null;
    const decisionRaw = `${a.DECISION ?? ""}`.trim() || null;
    const status = acpDecisionToStatus(decisionRaw);
    const decided = status !== "pending";
    const stats = shd.get(caseId);
    if (stats?.commencementDate) commencementByRef.set(`ABP-${caseId}`, stats.commencementDate);
    const category = `${a.CATEGORY ?? ""}`;
    records.push({
      authority_id: ACP_AUTHORITY.id,
      planning_reference: `ABP-${caseId}`,
      description,
      application_type: typeForCategory(category),
      application_type_raw: category || null,
      is_domestic_guess: 0,
      status,
      status_raw: decisionRaw,
      received_date: epochToIso(a.LODGEDON),
      validated_date: null,
      further_info_requested_date: null,
      further_info_received_date: null,
      decision_due_date: null,
      submissions_by_date: null,
      decision: decided ? decisionRaw : null,
      decision_raw: decisionRaw,
      decision_date: decided ? epochToIso(a.DECIDED_ON) : null,
      appeal_status: null,
      appeal_reference: null,
      appeal_lodged_date: null,
      appeal_decision: null,
      appeal_decision_date: null,
      final_grant_date: null,
      applicant_name: null,
      agent_name: null,
      address_text: `${a.DEVADDRESS ?? ""}`.trim() || null,
      eircode: null,
      num_residential_units: stats?.units ?? extractResidentialUnits(description),
      floor_area_sqm: null,
      site_area_ha: null,
      expiry_date: null,
      lat: f.centroid?.y ?? null,
      lng: f.centroid?.x ?? null,
      geom_polygon: (() => {
        const coords = f.geometry?.rings ? ringsToMultiPolygon(f.geometry.rings) : null;
        return coords ? JSON.stringify({ type: "MultiPolygon", coordinates: coords }) : null;
      })(),
      source_url: `${a.LINKABPWEB ?? ""}`.trim() || `https://www.pleanala.ie/en-ie/case/${caseId}`,
      last_synced: now,
    });
  }
  return { records, commencementByRef };
}
