/**
 * Backfill from Cork City Council's open data CSV (CC-BY 4.0,
 * data.corkcity.ie). ~9,000 records from 2014–2025 — the national feed
 * starts at 2017 for Cork City, so this adds ~2,400 pre-2017 records.
 *
 * Run during export-json.ts AFTER the national fetch so the national row
 * wins on overlap (first-seen wins via the `have` Set).
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

const CSV_URL =
  "https://data.corkcity.ie/datastore/dump/8d5bbfa9-3b0c-40ac-8630-4243bed94b2d";

type Row = Record<string, string>;

function str(row: Row, field: string): string | null {
  const v = row[field];
  if (v == null) return null;
  const s = v.trim();
  return s.length ? s : null;
}

function isoDate(row: Row, field: string): string | null {
  const v = row[field];
  if (!v || !v.trim()) return null;
  const s = v.trim();
  // Cork dates are "2019-04-30T00:00:00" without a timezone — treat as UTC
  // to avoid local-timezone day shifts.
  const d = new Date(s.endsWith("Z") ? s : s + "Z");
  if (!Number.isFinite(d.getTime())) return null;
  return d.toISOString().slice(0, 10);
}

function num(row: Row, field: string): number | null {
  const v = row[field];
  if (v == null || !v.trim()) return null;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function buildApplicantName(row: Row): string | null {
  const fore = str(row, "ApplicantForename");
  const sur = str(row, "ApplicantSurname");
  const joined = [fore, sur].filter(Boolean).join(" ").trim();
  return joined.length ? joined : null;
}

export function corkCsvRowToRecord(
  row: Row,
  now: string
): ApplicationRecord | null {
  const reference = str(row, "ApplicationNumber");
  if (!reference) return null;

  const description = str(row, "DevelopmentDescription");
  const statusRaw = str(row, "ApplicationStatus");
  const decisionRaw = str(row, "Decision");
  const typeRaw = str(row, "ApplicationType");
  const withdrawnDate = isoDate(row, "WithdrawnDate");
  const grantDate = isoDate(row, "GrantDate");
  const appealDecision = str(row, "AppealDecision");

  const auth = AUTHORITY_BY_ID.get("cork-city")!;

  // All coordinates in this dataset are wrong (~56.25°N, Scotland).
  // Records are still valuable for search — they just won't have map pins.
  let lat: number | null = null;
  let lng: number | null = null;
  const rawLat = Number(row["Latitude"]);
  const rawLng = Number(row["Longitude"]);
  if (Number.isFinite(rawLat) && Number.isFinite(rawLng)) {
    const [w, s, e, n] = auth.bbox;
    if (rawLng >= w - 0.5 && rawLng <= e + 0.5 && rawLat >= s - 0.5 && rawLat <= n + 0.5) {
      lat = rawLat;
      lng = rawLng;
    }
  }

  let councilStatus = withdrawnDate
    ? "withdrawn" as const
    : normalizeStatus(statusRaw, decisionRaw);
  if ((councilStatus === "unknown" || councilStatus === "pending") && grantDate) {
    councilStatus = "granted";
  }
  const appealStatus = appealDecision ? normalizeStatus("decided", appealDecision) : null;

  return {
    authority_id: "cork-city",
    planning_reference: reference,
    description,
    application_type: deriveApplicationType(typeRaw, description),
    application_type_raw: typeRaw,
    is_domestic_guess: guessIsDomestic(description) ? 1 : 0,
    is_one_off: isOneOffHouse(description) ? 1 : 0,
    status: withdrawnDate
      ? "withdrawn"
      : appealStatus && appealStatus !== "unknown"
        ? appealStatus
        : councilStatus,
    status_raw: statusRaw,
    received_date: isoDate(row, "ReceivedDate"),
    validated_date: null,
    further_info_requested_date: isoDate(row, "FIRequestDate"),
    further_info_received_date: isoDate(row, "FIRecDate"),
    decision_due_date: isoDate(row, "DecisionDueDate"),
    submissions_by_date: null,
    decision: realDecision(decisionRaw),
    decision_raw: decisionRaw,
    decision_date: isoDate(row, "DecisionDate"),
    appeal_status: str(row, "AppealStatus"),
    appeal_reference: str(row, "AppealRefNum"),
    appeal_lodged_date: isoDate(row, "AppealSubmittedDate"),
    appeal_decision: appealDecision,
    appeal_decision_date: isoDate(row, "AppealDecisionDate"),
    final_grant_date: grantDate,
    applicant_name: buildApplicantName(row),
    agent_name: null,
    address_text: str(row, "DevelopmentAddress"),
    eircode:
      extractEircode(str(row, "DevelopmentAddress")) ??
      extractEircode(description),
    num_residential_units: num(row, "NumResidentialUnits") ?? extractResidentialUnits(description),
    floor_area_sqm: num(row, "FloorArea"),
    site_area_ha: null,
    expiry_date: isoDate(row, "ExpiryDate"),
    lat,
    lng,
    geom_polygon: null,
    source_url: str(row, "LinkAppDetails") ?? auth.portalUrlForReference(reference),
    last_synced: now,
  };
}

function parseCsv(text: string): Row[] {
  const lines = text.split("\n");
  if (lines.length < 2) return [];
  const headers = parseCsvLine(lines[0]);
  const rows: Row[] = [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    const values = parseCsvLine(line);
    const row: Row = {};
    for (let j = 0; j < headers.length; j++) {
      row[headers[j]] = values[j] ?? "";
    }
    rows.push(row);
  }
  return rows;
}

function parseCsvLine(line: string): string[] {
  const fields: string[] = [];
  let i = 0;
  while (i <= line.length) {
    if (i === line.length) {
      fields.push("");
      break;
    }
    if (line[i] === '"') {
      let value = "";
      i++;
      while (i < line.length) {
        if (line[i] === '"') {
          if (i + 1 < line.length && line[i + 1] === '"') {
            value += '"';
            i += 2;
          } else {
            i++;
            break;
          }
        } else {
          value += line[i];
          i++;
        }
      }
      fields.push(value);
      if (i < line.length && line[i] === ",") i++;
    } else {
      const next = line.indexOf(",", i);
      if (next === -1) {
        fields.push(line.slice(i));
        break;
      } else {
        fields.push(line.slice(i, next));
        i = next + 1;
      }
    }
  }
  return fields;
}

export async function fetchCorkCityBackfill(
  log: (msg: string) => void = () => {}
): Promise<ApplicationRecord[]> {
  log("Cork City backfill: fetching CSV …");
  const res = await fetch(CSV_URL);
  if (!res.ok) throw new Error(`Cork CSV: HTTP ${res.status}`);
  const text = await res.text();
  const rows = parseCsv(text);
  log(`Cork City backfill: parsed ${rows.length} rows`);

  const now = new Date().toISOString();
  const records: ApplicationRecord[] = [];
  let skipped = 0;
  for (const row of rows) {
    const rec = corkCsvRowToRecord(row, now);
    if (rec) records.push(rec);
    else skipped++;
  }
  log(`Cork City backfill: mapped ${records.length} records (${skipped} skipped)`);
  return records;
}
