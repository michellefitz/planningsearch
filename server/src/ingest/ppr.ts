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
}

const PPR_BASE =
  "https://www.propertypriceregister.ie/website/npsra/ppr/npsra-ppr.nsf/Downloads";

/** Same normalization must be applied to both PPR and planning addresses. */
export function normalizeAddress(s: string): string {
  let n = s.toUpperCase();
  n = n.replace(/[^A-Z0-9 ]/g, " ");
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

/** normalized address → sales, newest first. */
export async function buildPprIndex(
  counties: string[],
  years: number[],
  log: (msg: string) => void = () => {}
): Promise<Map<string, PprSale[]>> {
  const index = new Map<string, PprSale[]>();
  for (const county of counties) {
    for (const year of years) {
      const sales = await fetchPprCsv(county, year);
      if (!sales) {
        log(`  PPR ${county} ${year}: unavailable, skipping`);
        continue;
      }
      for (const sale of sales) {
        const key = normalizeAddress(sale.address);
        if (!isSpecificAddress(key)) continue;
        const list = index.get(key);
        if (list) list.push(sale);
        else index.set(key, [sale]);
      }
      log(`  PPR ${county} ${year}: ${sales.length} sales`);
      await new Promise((r) => setTimeout(r, 200)); // be polite
    }
  }
  for (const list of index.values()) list.sort((a, b) => b.date.localeCompare(a.date));
  return index;
}
