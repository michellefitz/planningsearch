/**
 * Kildare live ingest from eplanning's "Planning Application Lists" search
 * (Applications Received). The national DHLGH feed trails Kildare by ~3 months,
 * so this fills the gap with applications straight off the council register.
 *
 * The results page (POST /KildareCC/searchresults) is a table with columns:
 * File Number, Application Status, Decision Due Date, Decision Date, Decision
 * Code, Received Date, Applicant Name, Development Address, Description, LA Name.
 * The File Number is both the AppFileRefDetails id and the planning reference
 * used by the national feed's ApplicationNumber, so records dedup cleanly.
 *
 * These records carry no coordinates (the map's lat/lng only comes from the
 * national feed's geometry), so they are list/search-only until the national
 * feed catches up and supersedes them.
 */
import type { ApplicationRecord } from "../db.js";
import {
  deriveApplicationType,
  expandDecisionCode,
  guessIsDomestic,
  normalizeStatus,
} from "../normalize.js";
import { extractEircode } from "./ppr.js";

const stripTags = (h: string): string => h.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();

const decodeEntities = (s: string): string =>
  s
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ");

const cellText = (cell: string | undefined): string | null =>
  cell ? decodeEntities(stripTags(cell)).trim() || null : null;

/** "17/07/2026" → "2026-07-17"; null if no date. */
const dmyToIso = (cell: string | undefined): string | null => {
  const m = stripTags(cell ?? "").match(/(\d{2})\/(\d{2})\/(\d{4})/);
  return m ? `${m[3]}-${m[2]}-${m[1]}` : null;
};

/** The address cell is <br/>-separated lines; join to one comma-separated line. */
const addressText = (cell: string | undefined): string | null => {
  if (!cell) return null;
  const joined = decodeEntities(
    cell
      .replace(/<br\s*\/?>/gi, ", ")
      .replace(/<[^>]*>/g, " ")
  )
    .replace(/\s+/g, " ")
    .replace(/(,\s*)+/g, ", ")
    .replace(/^[,\s]+|[,\s]+$/g, "")
    .trim();
  return joined || null;
};

export interface EplanningListItem {
  /** File Number — the AppFileRefDetails id and the planning reference. */
  eplanningId: string;
  reference: string;
  statusText: string | null;
  decisionCode: string | null;
  receivedDate: string | null;
  decisionDueDate: string | null;
  decisionDate: string | null;
  applicant: string | null;
  address: string | null;
  description: string | null;
}

/**
 * Parse one results page. Robust to the surrounding markup: it takes any table
 * row whose first cell links to an AppFileRefDetails page, so navbar/other
 * tables are ignored and it returns empty rather than guessing if the layout
 * changes.
 */
export function parseEplanningList(html: string): EplanningListItem[] {
  const out: EplanningListItem[] = [];
  const seen = new Set<string>();
  for (const row of html.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const cells = [...row[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map((c) => c[1]);
    if (cells.length < 9) continue;
    const id = cells[0].match(/AppFileRefDetails\/(\d+)/i)?.[1];
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push({
      eplanningId: id,
      reference: cellText(cells[0]) ?? id,
      statusText: cellText(cells[1]),
      decisionDueDate: dmyToIso(cells[2]),
      decisionDate: dmyToIso(cells[3]),
      decisionCode: cellText(cells[4]),
      receivedDate: dmyToIso(cells[5]),
      applicant: cellText(cells[6]),
      address: addressText(cells[7]),
      description: cellText(cells[8]),
    });
  }
  return out;
}

/** "Page 1 of 4 (33 Applications)" → 4; 1 if not found. */
export function parseTotalPages(html: string): number {
  const m = html.match(/Page\s+\d+\s+of\s+(\d+)/i);
  return m ? Math.max(1, Number(m[1])) : 1;
}

/** Map one list row onto the canonical record (Kildare, no coordinates). */
export function eplanningItemToRecord(item: EplanningListItem, now: string): ApplicationRecord {
  return {
    authority_id: "kildare",
    planning_reference: item.reference,
    description: item.description,
    application_type: deriveApplicationType(null, item.description),
    application_type_raw: null,
    is_domestic_guess: guessIsDomestic(item.description) ? 1 : 0,
    // Status from the list wording plus the single-letter decision code.
    status: normalizeStatus(item.statusText, expandDecisionCode(item.decisionCode)),
    status_raw: item.statusText,
    received_date: item.receivedDate,
    validated_date: null,
    further_info_requested_date: null,
    further_info_received_date: null,
    decision_due_date: item.decisionDueDate,
    // The list carries only a decision code, not the outcome text — leave the
    // decision text null (the detail page / national feed fills it later).
    decision: null,
    decision_raw: item.decisionCode,
    decision_date: item.decisionDate,
    appeal_status: null,
    appeal_reference: null,
    appeal_lodged_date: null,
    appeal_decision: null,
    appeal_decision_date: null,
    final_grant_date: null,
    applicant_name: item.applicant,
    agent_name: null,
    address_text: item.address,
    eircode: extractEircode(item.address),
    num_residential_units: null,
    floor_area_sqm: null,
    site_area_ha: null,
    expiry_date: null,
    // No coordinates from the register list — list/search-only until the
    // national feed (with geometry) supersedes this record.
    lat: null,
    lng: null,
    geom_polygon: null,
    source_url: `https://www.eplanning.ie/KildareCC/AppFileRefDetails/${item.eplanningId}/0`,
    last_synced: now,
  };
}
