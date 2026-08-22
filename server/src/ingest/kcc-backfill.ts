/**
 * Backfill from Kildare County Council's own ArcGIS planning points service
 * (CC-BY 4.0, data.gov.ie). 51,063 records reaching back to 1955 — the
 * national feed only starts at 2017 for Kildare, so this triples coverage.
 *
 * Run during export-json.ts BEFORE the national fetch and ePlanning top-up,
 * so the national row wins on overlap (same key, last write wins).
 */
import type { ApplicationRecord } from "../db.js";
import {
  deriveApplicationType,
  extractResidentialUnits,
  guessIsDomestic,
  isOneOffHouse,
  normalizeStatus,
  realDecision,
} from "../normalize.js";
import { extractEircode } from "./ppr.js";
import { AUTHORITY_BY_ID } from "../config/authorities.js";
import { fetchCount, fetchPage, type ArcgisFeature } from "./arcgis.js";
import { mapPool } from "./pool.js";

export const KCC_SERVICE_URL =
  "https://services-eu1.arcgis.com/7382h3fBABGPKrTJ/arcgis/rest/services/KCC_Planning_Points/FeatureServer/0";

const PAGE_CONCURRENCY = 6;

const KCC_FIELDS = {
  reference: "File_Number",
  description: "Description",
  address: "Full_Address",
  forename: "Forename",
  surname: "Surname",
  status: "Status",
  applicationType: "Application_Type",
  decision: "Decision",
  received: "Received_Date",
  withdrawn: "Withdrawn_Date",
  decisionDate: "Decision_Date",
  decisionDueDate: "Decision_Due_Date",
  grantDate: "Grant_Date",
  expiryDate: "Expiry_Date",
  submissionsBy: "Last_Date_For_Submissions",
  appeals: "ACP_Appeals",
} as const;

type Attrs = Record<string, unknown>;

function str(attrs: Attrs, field: string): string | null {
  const v = attrs[field];
  if (v == null) return null;
  const s = String(v).trim();
  return s.length ? s : null;
}

function isoDate(attrs: Attrs, field: string): string | null {
  const v = attrs[field];
  if (v == null || v === "") return null;
  const n = typeof v === "number" ? v : Date.parse(String(v));
  if (!Number.isFinite(n)) return null;
  return new Date(n).toISOString().slice(0, 10);
}

function buildApplicantName(attrs: Attrs): string | null {
  const fore = str(attrs, KCC_FIELDS.forename);
  const sur = str(attrs, KCC_FIELDS.surname);
  const joined = [fore, sur].filter(Boolean).join(" ").trim();
  return joined.length ? joined : null;
}

export function kccFeatureToRecord(
  feature: ArcgisFeature,
  now: string
): ApplicationRecord | null {
  const attrs = feature.attributes;
  const reference = str(attrs, KCC_FIELDS.reference);
  if (!reference) return null;

  const description = str(attrs, KCC_FIELDS.description);
  const statusRaw = str(attrs, KCC_FIELDS.status);
  const decisionRaw = str(attrs, KCC_FIELDS.decision);
  const typeRaw = str(attrs, KCC_FIELDS.applicationType);
  const withdrawnDate = isoDate(attrs, KCC_FIELDS.withdrawn);
  const grantDate = isoDate(attrs, KCC_FIELDS.grantDate);

  const auth = AUTHORITY_BY_ID.get("kildare")!;
  let lat: number | null = null;
  let lng: number | null = null;
  if (
    feature.geometry &&
    typeof feature.geometry.x === "number" &&
    typeof feature.geometry.y === "number"
  ) {
    lng = feature.geometry.x;
    lat = feature.geometry.y;
    const [w, s, e, n] = auth.bbox;
    if (lng < w - 0.5 || lng > e + 0.5 || lat < s - 0.5 || lat > n + 0.5) {
      lat = null;
      lng = null;
    }
  }

  let status = withdrawnDate
    ? "withdrawn" as const
    : normalizeStatus(statusRaw, decisionRaw);
  if ((status === "unknown" || status === "pending") && grantDate) {
    status = "granted";
  }

  return {
    authority_id: "kildare",
    planning_reference: reference,
    description,
    application_type: deriveApplicationType(typeRaw, description),
    application_type_raw: typeRaw,
    is_domestic_guess: guessIsDomestic(description) ? 1 : 0,
    is_one_off: isOneOffHouse(description) ? 1 : 0,
    status,
    status_raw: statusRaw,
    received_date: isoDate(attrs, KCC_FIELDS.received),
    validated_date: null,
    further_info_requested_date: null,
    further_info_received_date: null,
    decision_due_date: isoDate(attrs, KCC_FIELDS.decisionDueDate),
    submissions_by_date: isoDate(attrs, KCC_FIELDS.submissionsBy),
    decision: realDecision(decisionRaw),
    decision_raw: decisionRaw,
    decision_date: isoDate(attrs, KCC_FIELDS.decisionDate),
    appeal_status: null,
    appeal_reference: null,
    appeal_lodged_date: null,
    appeal_decision: null,
    appeal_decision_date: null,
    final_grant_date: grantDate,
    applicant_name: buildApplicantName(attrs),
    agent_name: null,
    address_text: str(attrs, KCC_FIELDS.address),
    eircode:
      extractEircode(str(attrs, KCC_FIELDS.address)) ??
      extractEircode(description),
    num_residential_units: extractResidentialUnits(description),
    floor_area_sqm: null,
    site_area_ha: null,
    expiry_date: isoDate(attrs, KCC_FIELDS.expiryDate),
    lat,
    lng,
    geom_polygon: null,
    source_url: `https://www.eplanning.ie/KildareCC/AppFileRefDetails/${reference}/0`,
    last_synced: now,
  };
}

async function fetchPageWithRetry(
  where: string,
  offset: number,
  pageSize: number
): Promise<ArcgisFeature[]> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fetchPage({
        where,
        offset,
        pageSize,
        serviceUrl: KCC_SERVICE_URL,
      });
    } catch (err) {
      if (attempt === 3) throw err;
      await new Promise((r) => setTimeout(r, attempt * 2000));
    }
  }
}

export async function fetchKccBackfill(
  log: (msg: string) => void = () => {}
): Promise<ApplicationRecord[]> {
  const where = "1=1";
  const total = await fetchCount(where, KCC_SERVICE_URL);
  log(`KCC backfill: ${total ?? "unknown"} records on the service`);

  const pageSize = 1000;
  const now = new Date().toISOString();

  if (total != null) {
    const offsets: number[] = [];
    for (let o = 0; o < total; o += pageSize) offsets.push(o);
    let done = 0;
    const pages = await mapPool(offsets, PAGE_CONCURRENCY, async (offset) => {
      const features = await fetchPageWithRetry(where, offset, pageSize);
      done += features.length;
      log(`  KCC backfill: fetched ${done} of ${total}`);
      return features;
    });

    const records: ApplicationRecord[] = [];
    let skipped = 0;
    for (const f of pages.flat()) {
      const rec = kccFeatureToRecord(f, now);
      if (rec) records.push(rec);
      else skipped++;
    }
    log(`KCC backfill: mapped ${records.length} records (${skipped} skipped)`);
    return records;
  }

  // Fallback: serial pagination if count is unavailable
  const all: ApplicationRecord[] = [];
  for (let offset = 0; ; offset += pageSize) {
    const features = await fetchPageWithRetry(where, offset, pageSize);
    for (const f of features) {
      const rec = kccFeatureToRecord(f, now);
      if (rec) all.push(rec);
    }
    log(`  KCC backfill: fetched ${all.length} records so far`);
    if (features.length < pageSize) break;
  }
  return all;
}
