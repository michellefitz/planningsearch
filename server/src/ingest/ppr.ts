/**
 * Residential Property Price Register (PSRA) ingestion. The register is
 * published as per-county/per-year CSVs — free-text addresses, no
 * coordinates — so sales are joined to planning applications by normalized
 * address, and only for addresses containing a house/unit number: townland-
 * only addresses are shared by many properties, and a wrong price is worse
 * than no price.
 */

export interface PprSale {
  date: string; // ISO yyyy-mm-dd
  price: number; // euro, rounded
  address: string;
  /** e.g. "New Dwelling house /Apartment", "Second-Hand Dwelling house /Apartment" */
  description: string | null;
  vatExclusive: boolean;
  notFullMarket: boolean;
  /** Normalised Eircode key (no space), when the register carries one. */
  eircode: string | null;
}

/**
 * Normalised Eircode match key (uppercase, no space), or null if it isn't a real
 * Eircode. Both the register and our applications leave the field blank or put
 * junk in it (Dublin tenants use "2." etc.), so validate the shape — routing key
 * (D6W or letter+2 digits) plus the 4-char unique identifier.
 */
export function eircodeKey(raw: string | null | undefined): string | null {
  const s = String(raw ?? "")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
  return /^(D6W|[A-Z]\d{2})[A-Z0-9]{4}$/.test(s) ? s : null;
}

const PPR_BASE =
  "https://www.propertypriceregister.ie/website/npsra/ppr/npsra-ppr.nsf/Downloads";

/** Eircode as it appears embedded in free text: routing key (D6W or letter+2
 *  digits) then the 4-char unique identifier, optionally space-separated. */
const EIRCODE_IN_TEXT = /\b(D6W|[A-Z]\d{2}) ?([A-Z0-9]{4})\b/;

/** Pull a formatted Eircode ("D03 WP89") out of free text — e.g. a planning
 *  address that embeds it — or null. */
export function extractEircode(text: string | null | undefined): string | null {
  const m = `${text ?? ""}`.toUpperCase().match(EIRCODE_IN_TEXT);
  return m ? `${m[1]} ${m[2]}` : null;
}

/** Same normalization must be applied to both PPR and planning addresses. */
export function normalizeAddress(s: string): string {
  let n = s.toUpperCase();
  n = n.replace(/[^A-Z0-9 ]/g, " ");
  // Drop an embedded Eircode so it doesn't defeat the address match (planning
  // addresses carry it, PPR's address column doesn't). Applied to both sides.
  n = n.replace(new RegExp(EIRCODE_IN_TEXT.source, "g"), " ");
  n = n.replace(/\b(CO|COUNTY)\s+(KILDARE|DUBLIN|WICKLOW|MEATH)\b/g, " ");
  n = n.replace(/\s+/g, " ").trim();
  // A trailing bare county name adds nothing ("... NAAS KILDARE").
  n = n.replace(/\s(KILDARE|DUBLIN)$/g, "");
  return n.trim();
}

/** Only addresses with a house/unit number identify one property. */
export function isSpecificAddress(normalized: string): boolean {
  return /\d/.test(normalized);
}

/** Minimal RFC-4180-ish parser (quoted fields, embedded commas). */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let field = "";
  let row: string[] = [];
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else inQuotes = false;
      } else field += c;
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      if (field.length || row.length) {
        row.push(field);
        rows.push(row);
        field = "";
        row = [];
      }
    } else field += c;
  }
  if (field.length || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

function parsePrice(s: string): number | null {
  const n = Number(s.replace(/[^0-9.]/g, ""));
  return Number.isFinite(n) && n > 0 ? Math.round(n) : null;
}

function parseDmy(s: string): string | null {
  const m = s.trim().match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  return m ? `${m[3]}-${m[2]}-${m[1]}` : null;
}

export function parsePprCsv(text: string): PprSale[] {
  const rows = parseCsv(text);
  const sales: PprSale[] = [];
  for (const row of rows.slice(1)) {
    if (row.length < 5) continue;
    const date = parseDmy(row[0]);
    const price = parsePrice(row[4]);
    const address = row[1]?.trim();
    if (date && price && address) {
      sales.push({
        date,
        price,
        address,
        description: row[7]?.trim() || null,
        vatExclusive: /^yes$/i.test(row[6]?.trim() ?? ""),
        notFullMarket: /^yes$/i.test(row[5]?.trim() ?? ""),
        // Column 3 is the Eircode (sparsely filled in the register).
        eircode: eircodeKey(row[3]),
      });
    }
  }
  return sales;
}

/**
 * Download one county/year CSV; null on failure (a missing year should not
 * fail the whole export). The register serves windows-1252.
 */
async function fetchPprCsv(county: string, year: number): Promise<PprSale[] | null> {
  const name = `PPR-${year}-${county}.csv`;
  const url = `${PPR_BASE}/${name}/$FILE/${name}`;
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0 (PlanView data build)" },
    });
    if (!res.ok) return null;
    const text = new TextDecoder("windows-1252").decode(await res.arrayBuffer());
    return parsePprCsv(text);
  } catch {
    return null;
  }
}

export interface PprIndex {
  /** Normalised specific-address → sales, newest first. */
  byAddress: Map<string, PprSale[]>;
  /** Normalised Eircode → sales, newest first. */
  byEircode: Map<string, PprSale[]>;
}

/** Fetch the county/year CSVs and index sales by both address and Eircode. */
export async function buildPprIndex(
  counties: string[],
  years: number[],
  log: (msg: string) => void = () => {}
): Promise<PprIndex> {
  const byAddress = new Map<string, PprSale[]>();
  const byEircode = new Map<string, PprSale[]>();
  const push = (m: Map<string, PprSale[]>, key: string, sale: PprSale) => {
    const list = m.get(key);
    if (list) list.push(sale);
    else m.set(key, [sale]);
  };
  for (const county of counties) {
    for (const year of years) {
      const sales = await fetchPprCsv(county, year);
      if (!sales) {
        log(`  PPR ${county} ${year}: unavailable, skipping`);
        continue;
      }
      for (const sale of sales) {
        const addrKey = normalizeAddress(sale.address);
        if (isSpecificAddress(addrKey)) push(byAddress, addrKey, sale);
        if (sale.eircode) push(byEircode, sale.eircode, sale);
      }
      log(`  PPR ${county} ${year}: ${sales.length} sales`);
      await new Promise((r) => setTimeout(r, 200)); // be polite
    }
  }
  for (const m of [byAddress, byEircode]) {
    for (const list of m.values()) list.sort((a, b) => b.date.localeCompare(a.date));
  }
  return { byAddress, byEircode };
}

/**
 * Sales for one application: Eircode match first — a unique property identifier,
 * so it works even for apartments where many units share a street address — then
 * a specific (number-bearing) address match. Null when neither hits.
 */
export function lookupPpr(
  index: PprIndex,
  app: { address_text?: string | null; eircode?: string | null }
): PprSale[] | null {
  // Prefer the eircode field, but recover one embedded in the address too —
  // Dublin addresses routinely carry the Eircode while the field is blank.
  const ek = eircodeKey(app.eircode) ?? eircodeKey(extractEircode(app.address_text));
  if (ek) {
    const hit = index.byEircode.get(ek);
    if (hit?.length) return hit;
  }
  if (app.address_text) {
    const key = normalizeAddress(app.address_text);
    if (isSpecificAddress(key)) {
      const hit = index.byAddress.get(key);
      if (hit?.length) return hit;
    }
  }
  return null;
}
