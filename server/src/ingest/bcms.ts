/**
 * Commencement notices from the Building Control Management System (BCMS),
 * via the NBCO open-data portal's CKAN datastore (data.nbco.gov.ie, CC-BY).
 * One row per *building* on a notice; notices carry the planning permission
 * number the builder cited, the notified commencement date, and (where works
 * finished) the Certificate of Compliance on Completion.
 *
 * The permission number is free text typed by the submitter, so joining to
 * the register needs normalisation: casings, separators, and web-submission
 * suffixes ("…/WEB", trailing "W") all vary, and some submitters cite the
 * An Bord Pleanála reference instead of the council's.
 */

import { mapPool } from "./pool.js";

const DATASTORE_URL = "https://data.nbco.gov.ie/api/3/action/datastore_search";
export const BCMS_RESOURCE_ID = "0774e781-7af8-46da-b623-872e74cf541e";
const PAGE_SIZE = 10_000;
const TIMEOUT_MS = 90_000;
/** Pages pulled in parallel once the first page reports the total. The portal
 *  can be flaky, so keep this modest. */
const PAGE_CONCURRENCY = 4;

/** LocalAuthority strings as they appear in the BCMS dataset. */
export const BCMS_AUTHORITY_NAMES: Record<string, string> = {
  "dublin-city": "Dublin City Council",
  fingal: "Fingal County Council",
  "south-dublin": "South Dublin County Council",
  dlr: "Dún-Laoghaire Rathdown County Council",
  kildare: "Kildare County Council",
};

export interface Commencement {
  /** Notice number, e.g. CN0139753FL (SN = 7-day notice). */
  notice: string;
  /** Notified commencement date (works may start 14–28 days after filing). */
  commencement_date: string | null;
  /** Certificate of Compliance on Completion validation date, if any. */
  completion_date: string | null;
  /** Dwelling units on the notice, where stated. */
  units: number | null;
  /** Number of notices matched to the permission (phased sites file several). */
  count: number;
}

interface RawRow {
  CN_Number?: string | null;
  CN_Planning_Permission_Number?: string | null;
  CN_Commencement_Date?: string | null;
  CCC_Date_Validated?: string | null;
  CN_Total_Number_of_Dwelling_Units?: number | string | null;
  LocalAuthority?: string | null;
}

const FIELDS = [
  "CN_Number",
  "CN_Planning_Permission_Number",
  "CN_Commencement_Date",
  "CCC_Date_Validated",
  "CN_Total_Number_of_Dwelling_Units",
  "LocalAuthority",
].join(",");

async function fetchPage(
  authorityName: string,
  offset: number,
  tries = 4
): Promise<{ records: RawRow[]; total: number }> {
  const params = new URLSearchParams({
    resource_id: BCMS_RESOURCE_ID,
    filters: JSON.stringify({ LocalAuthority: authorityName }),
    fields: FIELDS,
    limit: String(PAGE_SIZE),
    offset: String(offset),
  });
  let lastErr: unknown;
  for (let i = 0; i < tries; i++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const res = await fetch(`${DATASTORE_URL}?${params}`, {
        signal: controller.signal,
        // The portal serves empty responses without a browser-ish UA.
        headers: { "User-Agent": "PlanView/0.1 (planning register viewer)", Accept: "application/json" },
      });
      const body = (await res.json()) as {
        success?: boolean;
        result?: { records?: RawRow[]; total?: number };
      };
      if (body.success && body.result) {
        return { records: body.result.records ?? [], total: body.result.total ?? 0 };
      }
      lastErr = new Error(`datastore_search unsuccessful (HTTP ${res.status})`);
    } catch (err) {
      lastErr = err;
    } finally {
      clearTimeout(timer);
    }
    await new Promise((r) => setTimeout(r, 1500 * (i + 1)));
  }
  throw lastErr;
}

/**
 * Normalised join keys for one reference: canonical form plus web-submission
 * variants (both sides get the same treatment, so "D25A/0678/WEB" in BCMS
 * meets "D25A/0678" from the register and vice versa).
 */
export function refVariants(raw: unknown): string[] {
  const s = String(raw ?? "")
    .toUpperCase()
    .replace(/\^/g, " ") // BCMS wraps some values in carets
    .trim();
  if (!s) return [];
  const canon = s.replace(/[^A-Z0-9]/g, "");
  if (canon.length < 4) return []; // "2.", "N/A" and similar junk
  const variants = new Set<string>([canon]);
  // Web-submission suffixes sit directly after the sequence digits.
  if (/\dWEB$/.test(canon)) variants.add(canon.slice(0, -3));
  else if (/\dW$/.test(canon)) variants.add(canon.slice(0, -1));
  return [...variants];
}

function isoDate(v: unknown): string | null {
  const s = String(v ?? "").slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
}

function num(v: unknown): number | null {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * Fetch all commencement/completion rows for the given authorities and build
 * a lookup of normalised reference → aggregated commencement. Rows are
 * per-building, so notices are deduped by CN_Number first; where several
 * notices cite one permission (phased sites), the earliest commencement and
 * latest completion win and units take the largest notice total.
 */
export async function buildCommencementIndex(
  authorityIds: string[] = Object.keys(BCMS_AUTHORITY_NAMES),
  log: (msg: string) => void = () => {}
): Promise<Map<string, Commencement>> {
  const index = new Map<string, Commencement>();
  for (const authorityId of authorityIds) {
    const laName = BCMS_AUTHORITY_NAMES[authorityId];
    if (!laName) continue;
    // Dedupe per-building rows into one record per notice.
    const notices = new Map<string, { ref: string; commenced: string | null; ccc: string | null; units: number | null }>();
    // The first page reports the total, so the rest can be pulled a few at a
    // time instead of discovered one page after another.
    const first = await fetchPage(laName, 0);
    const offsets: number[] = [];
    for (let o = PAGE_SIZE; o < first.total; o += PAGE_SIZE) offsets.push(o);
    const rest = await mapPool(offsets, PAGE_CONCURRENCY, (o) => fetchPage(laName, o));
    for (const { records } of [first, ...rest]) {
      for (const r of records) {
        const cn = String(r.CN_Number ?? "").trim();
        const ref = String(r.CN_Planning_Permission_Number ?? "").trim();
        if (!cn || !ref) continue;
        const prev = notices.get(cn);
        const commenced = isoDate(r.CN_Commencement_Date) ?? prev?.commenced ?? null;
        const ccc = isoDate(r.CCC_Date_Validated) ?? prev?.ccc ?? null;
        const units = Math.max(num(r.CN_Total_Number_of_Dwelling_Units) ?? 0, prev?.units ?? 0) || null;
        notices.set(cn, { ref, commenced, ccc, units });
      }
    }
    log(`  BCMS ${laName}: ${notices.size} notices`);
    for (const [cn, n] of notices) {
      for (const variant of refVariants(n.ref)) {
        const key = `${authorityId}:${variant}`;
        const prev = index.get(key);
        if (!prev) {
          index.set(key, {
            notice: cn,
            commencement_date: n.commenced,
            completion_date: n.ccc,
            units: n.units,
            count: 1,
          });
        } else {
          prev.count += 1;
          if (n.commenced && (!prev.commencement_date || n.commenced < prev.commencement_date)) {
            prev.commencement_date = n.commenced;
            prev.notice = cn;
          }
          if (n.ccc && (!prev.completion_date || n.ccc > prev.completion_date)) prev.completion_date = n.ccc;
          if (n.units && (!prev.units || n.units > prev.units)) prev.units = n.units;
        }
      }
    }
  }
  return index;
}

/**
 * Look up an application in the index — by its planning reference first,
 * falling back to its An Bord Pleanála reference (some notices cite the
 * appeal decision rather than the council permission).
 */
export function lookupCommencement(
  index: Map<string, Commencement>,
  authorityId: string,
  planningReference: string,
  appealReference?: string | null
): Commencement | null {
  for (const v of refVariants(planningReference)) {
    const hit = index.get(`${authorityId}:${v}`);
    if (hit) return hit;
  }
  if (appealReference) {
    for (const v of refVariants(appealReference)) {
      const hit = index.get(`${authorityId}:${v}`);
      if (hit) return hit;
    }
  }
  return null;
}
