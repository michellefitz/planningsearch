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
 * Each record's map coordinates come from its detail page's "Site Location"
 * tab, which carries exact ITM grid coordinates (converted to WGS84) — so
 * these show on the map straight away, ahead of the national feed's geometry.
 */
import type { ApplicationRecord } from "../db.js";
import {
  deriveApplicationType,
  expandDecisionCode,
  extractResidentialUnits,
  guessIsDomestic,
  isOneOffHouse,
  normalizeStatus,
} from "../normalize.js";
import { extractEircode } from "./ppr.js";
import { itmToLatLng } from "./itm.js";
import { mapPool } from "./pool.js";

/** Detail pages fetched in parallel — modest load, minutes off the build. */
const DETAIL_CONCURRENCY = 6;

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
  /** WGS84 coordinates from the detail page's Site Location tab, if fetched. */
  lat: number | null;
  lng: number | null;
  /** From the detail page: the council's application type wording. */
  applicationTypeRaw: string | null;
  /** From the detail page: deadline for submissions/observations, ISO. */
  submissionsBy: string | null;
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
      lat: null,
      lng: null,
      applicationTypeRaw: null,
      submissionsBy: null,
    });
  }
  return out;
}

/** "Page 1 of 4 (33 Applications)" → 4; 1 if not found. */
export function parseTotalPages(html: string): number {
  const m = html.match(/Page\s+\d+\s+of\s+(\d+)/i);
  return m ? Math.max(1, Number(m[1])) : 1;
}

/**
 * Read a labelled field from a detail page: the pages are `<th>Label:</th>
 * <td>value</td>` pairs throughout, so one matcher serves every field.
 */
function detailField(html: string, label: string): string | null {
  const re = new RegExp(
    `<th[^>]*>\\s*${label.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\\\$&")}\\s*:?\\s*</th>\\s*<td[^>]*>([\\s\\S]*?)</td>`,
    "i"
  );
  const m = html.match(re);
  return m ? decodeEntities(stripTags(m[1])).trim() || null : null;
}

/**
 * The application type as the council records it ("PERMISSION", "RETENTION",
 * "OUTLINE PERMISSION"…). The list search has no type column, so without this
 * the type had to be guessed from the description and fell back to "other".
 */
export function parseApplicationTypeRaw(html: string): string | null {
  return detailField(html, "Application Type");
}

/**
 * The date up to which submissions/observations can be made on an application
 * ("Submissions By" on the Details tab), normalised to ISO.
 */
export function parseSubmissionsBy(html: string): string | null {
  const raw = detailField(html, "Submissions By");
  const m = raw?.match(/(\d{2})\/(\d{2})\/(\d{4})/);
  return m ? `${m[3]}-${m[2]}-${m[1]}` : null;
}

/**
 * Pull the full development description from a detail page's "Development" tab.
 * The list search only carries a truncated description; the detail page has the
 * complete text in:
 *   <th>Development Description: </th><td colspan="3">…full text…</td>
 * Returns null if the field is absent or empty.
 */
export function parseFullDescription(html: string): string | null {
  const m = html.match(/Development Description\s*:?\s*<\/th>\s*<td[^>]*>([\s\S]*?)<\/td>/i);
  if (!m) return null;
  const text = decodeEntities(stripTags(m[1])).trim();
  return text || null;
}

/**
 * Pull the site's coordinates from a detail page's "Site Location Details"
 * table. eplanning gives exact ITM grid coordinates (Grid Eastings/Northings,
 * EPSG:2157), which we convert to WGS84 — far better than geocoding an address.
 *
 * The markup is a hidden div:
 *   <th>Grid Northings:</th><td>736395.02375417</td>
 *   <th>Grid Eastings:</th><td>698588.1612861</td>
 * Returns null if either coordinate is missing or lands outside Ireland's
 * bounding box (a guard against parsing garbage).
 */
export function parseSiteLocation(html: string): { lat: number; lng: number } | null {
  const north = html.match(
    /Grid\s+Northings\s*:?\s*<\/th>\s*<td[^>]*>\s*([\d.]+)/i
  )?.[1];
  const east = html.match(/Grid\s+Eastings\s*:?\s*<\/th>\s*<td[^>]*>\s*([\d.]+)/i)?.[1];
  if (!north || !east) return null;
  const northing = Number(north);
  const easting = Number(east);
  if (!Number.isFinite(northing) || !Number.isFinite(easting)) return null;
  // ITM eastings/northings for Ireland sit well inside these bounds; 0/0 or a
  // stray small number means "no location recorded".
  if (easting < 400_000 || easting > 800_000 || northing < 500_000 || northing > 1_000_000) {
    return null;
  }
  const { lat, lng } = itmToLatLng(easting, northing);
  // Sanity-check against Ireland's rough bounding box.
  if (lat < 51.3 || lat > 55.5 || lng < -10.7 || lng > -5.3) return null;
  return { lat, lng };
}

const EPLAN_BASE = "https://www.eplanning.ie/KildareCC";
const UA_HEADERS = {
  "User-Agent": "PlanView/0.1 (planning register viewer; respectful build-time fetch)",
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
};
const TIMEOUT_MS = 20_000;

async function fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

export interface EplanningDetail {
  coords: { lat: number; lng: number } | null;
  /** Full development description (the list one is truncated). */
  description: string | null;
  /** The council's own application type wording, absent from the list search. */
  applicationTypeRaw: string | null;
  /** Deadline for submissions/observations, ISO. */
  submissionsBy: string | null;
}

/**
 * Fetch one application's detail page and pull its Site Location coordinates
 * and full development description in a single request. Best-effort: returns
 * nulls on any error (a record without a pin/full description is still useful).
 * `cookies` reuses the search session.
 */
const EMPTY_DETAIL: EplanningDetail = {
  coords: null,
  description: null,
  applicationTypeRaw: null,
  submissionsBy: null,
};

async function fetchDetail(id: string, cookies: string): Promise<EplanningDetail> {
  try {
    const res = await fetchWithTimeout(`${EPLAN_BASE}/AppFileRefDetails/${id}/0`, {
      headers: { ...UA_HEADERS, Cookie: cookies },
    });
    if (!res.ok) return EMPTY_DETAIL;
    const html = await res.text();
    return {
      coords: parseSiteLocation(html),
      description: parseFullDescription(html),
      applicationTypeRaw: parseApplicationTypeRaw(html),
      submissionsBy: parseSubmissionsBy(html),
    };
  } catch {
    return EMPTY_DETAIL;
  }
}

/** Session/antiforgery cookies from a response, joined into a Cookie header. */
function cookieHeader(res: Response, extra: string[] = []): string {
  const h = res.headers as unknown as {
    getSetCookie?: () => string[];
    get: (k: string) => string | null;
  };
  const set = typeof h.getSetCookie === "function" ? h.getSetCookie() : [];
  // Fallback for runtimes without getSetCookie: the combined header.
  const raw = set.length ? set : h.get("set-cookie") ? [h.get("set-cookie") as string] : [];
  const pairs = raw.map((c) => c.split(";")[0].trim()).filter(Boolean);
  return [...pairs, ...extra].join("; ");
}

/**
 * Fetch recent Kildare applications from the eplanning "Applications Received"
 * list search (max window 42 days). Loads the form for a session cookie + a
 * matching antiforgery token, POSTs the list search, then walks the result
 * pages (held in session). Never throws for the caller to guard the build.
 */
export async function fetchKildareRecent(
  days = 42,
  log: (msg: string) => void = () => {}
): Promise<EplanningListItem[]> {
  const formRes = await fetchWithTimeout(`${EPLAN_BASE}/SearchListing/RECEIVED`, {
    headers: { ...UA_HEADERS, Cookie: "eplancomplianceCookie=on" },
  });
  const formHtml = await formRes.text();
  const token = formHtml.match(/name="__RequestVerificationToken"[^>]*value="([^"]+)"/i)?.[1];
  if (!token) throw new Error("eplanning: no antiforgery token on the search form");
  const cookies = cookieHeader(formRes, ["eplancomplianceCookie=on"]);

  // Mirror the browser's POST body exactly (captured form fields).
  const body = new URLSearchParams();
  body.append("__RequestVerificationToken", token);
  body.append("AppStatus", "0"); // Applications Received
  body.append("CheckBoxList[0].Id", "0");
  body.append("CheckBoxList[0].Name", "Kildare County Council");
  body.append("CheckBoxList[0].IsSelected", "true");
  body.append("CheckBoxList[0].IsSelected", "false"); // ASP.NET checkbox true/false pair
  body.append("RdoTimeLimit", String(days));
  body.append("SearchType", "Listing");
  body.append("CountyTownCount", "1");
  body.append("CountyTownCouncilNames", "Kildare County Council:0,");

  const first = await fetchWithTimeout(`${EPLAN_BASE}/searchresults`, {
    method: "POST",
    headers: {
      ...UA_HEADERS,
      "Content-Type": "application/x-www-form-urlencoded",
      Cookie: cookies,
      Origin: "https://www.eplanning.ie",
      Referer: `${EPLAN_BASE}/SearchListing/RECEIVED`,
    },
    body: body.toString(),
  });
  const firstHtml = await first.text();
  const items = parseEplanningList(firstHtml);
  const seen = new Set(items.map((i) => i.eplanningId));
  const pages = parseTotalPages(firstHtml);
  log(`  eplanning Kildare received (${days}d): page 1/${pages}, ${items.length} rows`);

  // Later pages are plain GETs against the session-held search.
  for (let p = 2; p <= pages; p++) {
    const res = await fetchWithTimeout(`${EPLAN_BASE}/searchresults/Default/${p}`, {
      headers: { ...UA_HEADERS, Cookie: cookies },
    });
    let n = 0;
    for (const row of parseEplanningList(await res.text())) {
      if (seen.has(row.eplanningId)) continue;
      seen.add(row.eplanningId);
      items.push(row);
      n++;
    }
    log(`  eplanning Kildare received: page ${p}/${pages}, +${n} rows`);
    await new Promise((r) => setTimeout(r, 300));
  }

  // Enrich each record from its detail page: exact Site Location coordinates
  // (ITM grid → WGS84) for the map pin, and the full development description
  // (the list one is truncated). One detail fetch per record, run a few at a
  // time — serially this dominated the build. Any failure just leaves that
  // record with what the list gave us.
  let located = 0;
  let described = 0;
  const details = await mapPool(items, DETAIL_CONCURRENCY, (item) =>
    fetchDetail(item.eplanningId, cookies)
  );
  items.forEach((item, i) => {
    const detail = details[i];
    if (detail.coords) {
      item.lat = detail.coords.lat;
      item.lng = detail.coords.lng;
      located++;
    }
    // Prefer the fuller detail-page text over the truncated list description.
    if (detail.description && detail.description.length > (item.description?.length ?? 0)) {
      item.description = detail.description;
      described++;
    }
    item.applicationTypeRaw = detail.applicationTypeRaw;
    item.submissionsBy = detail.submissionsBy;
  });
  log(
    `  eplanning Kildare received: located ${located}/${items.length} on the map, ` +
      `${described} full descriptions`
  );
  return items;
}

/** Map one list row onto the canonical record (Kildare, no coordinates). */
export function eplanningItemToRecord(item: EplanningListItem, now: string): ApplicationRecord {
  return {
    authority_id: "kildare",
    planning_reference: item.reference,
    description: item.description,
    // The council's own wording when the detail page gave it, else inferred
    // from the description (the list search has no type column).
    application_type: deriveApplicationType(item.applicationTypeRaw, item.description),
    application_type_raw: item.applicationTypeRaw,
    is_domestic_guess: guessIsDomestic(item.description) ? 1 : 0,
    is_one_off: isOneOffHouse(item.description) ? 1 : 0,
    // Status from the list wording plus the single-letter decision code.
    status: normalizeStatus(item.statusText, expandDecisionCode(item.decisionCode)),
    status_raw: item.statusText,
    received_date: item.receivedDate,
    validated_date: null,
    further_info_requested_date: null,
    further_info_received_date: null,
    decision_due_date: item.decisionDueDate,
    submissions_by_date: item.submissionsBy,
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
    num_residential_units: extractResidentialUnits(item.description),
    floor_area_sqm: null,
    site_area_ha: null,
    expiry_date: null,
    // Coordinates come from the detail page's Site Location tab (exact ITM
    // grid coordinates → WGS84); null if that page had none.
    lat: item.lat,
    lng: item.lng,
    geom_polygon: null,
    source_url: `https://www.eplanning.ie/KildareCC/AppFileRefDetails/${item.eplanningId}/0`,
    last_synced: now,
  };
}
