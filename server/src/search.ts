import type Database from "better-sqlite3";

export interface SearchFilters {
  q?: string;
  authorities?: string[];
  statuses?: string[];
  types?: string[];
  domesticOnly?: boolean;
  appealedOnly?: boolean;
  receivedFrom?: string;
  receivedTo?: string;
  decisionFrom?: string;
  decisionTo?: string;
  /** [west, south, east, north] — "search this area" (PRD F1.4). */
  bbox?: [number, number, number, number];
  /** Centre for distance sort / "near me". */
  near?: { lat: number; lng: number };
  sort?: "relevance" | "received" | "decision" | "distance";
  page?: number;
  limit?: number;
}

export interface SearchResultRow {
  id: number;
  authority_id: string;
  planning_reference: string;
  description: string | null;
  status: string;
  application_type: string;
  is_domestic_guess: number;
  received_date: string | null;
  decision: string | null;
  decision_date: string | null;
  address_text: string | null;
  lat: number | null;
  lng: number | null;
  distance_km?: number;
  match_quality?: "exact" | "fuzzy";
}

/** Escape a user token for use inside an FTS5 string literal. */
function ftsQuote(token: string): string {
  return `"${token.replace(/"/g, '""')}"`;
}

/**
 * Build the ranked FTS5 query: every token quoted (so `25/456` style planning
 * references survive) with prefix matching on the final token for
 * search-as-you-type.
 */
export function buildFtsQuery(q: string): string | null {
  const tokens = q
    .split(/\s+/)
    .map((t) => t.replace(/^[^\p{L}\p{N}/*-]+|[^\p{L}\p{N}/*-]+$/gu, ""))
    .filter(Boolean);
  if (tokens.length === 0) return null;
  return tokens
    .map((t, i) => {
      const isLast = i === tokens.length - 1;
      // A trailing * is the register-portal wildcard convention; map it (and
      // the final token generally) to FTS prefix search.
      const stripped = t.replace(/\*+$/, "");
      if (!stripped) return null;
      return isLast || t.endsWith("*") ? `${ftsQuote(stripped)}*` : ftsQuote(stripped);
    })
    .filter(Boolean)
    .join(" ");
}

/** Trigram OR-query for the typo-tolerant fallback (PRD F1.3). */
export function buildTrigramQuery(q: string): string | null {
  const compact = q.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
  const grams = new Set<string>();
  for (const word of compact.split(" ")) {
    for (let i = 0; i + 3 <= word.length; i++) grams.add(word.slice(i, i + 3));
  }
  if (grams.size === 0) return null;
  return [...grams].map((g) => ftsQuote(g)).join(" OR ");
}

function haversineKm(aLat: number, aLng: number, bLat: number, bLng: number): number {
  const R = 6371;
  const dLat = ((bLat - aLat) * Math.PI) / 180;
  const dLng = ((bLng - aLng) * Math.PI) / 180;
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((aLat * Math.PI) / 180) * Math.cos((bLat * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

interface WhereClause {
  sql: string;
  params: Record<string, unknown>;
}

function buildWhere(f: SearchFilters, alias = "a"): WhereClause {
  const clauses: string[] = [];
  const params: Record<string, unknown> = {};
  if (f.authorities?.length) {
    const keys = f.authorities.map((v, i) => {
      params[`auth${i}`] = v;
      return `@auth${i}`;
    });
    clauses.push(`${alias}.authority_id IN (${keys.join(",")})`);
  }
  if (f.statuses?.length) {
    const keys = f.statuses.map((v, i) => {
      params[`st${i}`] = v;
      return `@st${i}`;
    });
    clauses.push(`${alias}.status IN (${keys.join(",")})`);
  }
  if (f.types?.length) {
    const keys = f.types.map((v, i) => {
      params[`ty${i}`] = v;
      return `@ty${i}`;
    });
    clauses.push(`${alias}.application_type IN (${keys.join(",")})`);
  }
  if (f.domesticOnly) clauses.push(`${alias}.is_domestic_guess = 1`);
  if (f.appealedOnly) clauses.push(`${alias}.appeal_reference IS NOT NULL`);
  if (f.receivedFrom) {
    params.rf = f.receivedFrom;
    clauses.push(`${alias}.received_date >= @rf`);
  }
  if (f.receivedTo) {
    params.rt = f.receivedTo;
    clauses.push(`${alias}.received_date <= @rt`);
  }
  if (f.decisionFrom) {
    params.df = f.decisionFrom;
    clauses.push(`${alias}.decision_date >= @df`);
  }
  if (f.decisionTo) {
    params.dt = f.decisionTo;
    clauses.push(`${alias}.decision_date <= @dt`);
  }
  if (f.bbox) {
    const [w, s, e, n] = f.bbox;
    Object.assign(params, { bw: w, bs: s, be: e, bn: n });
    clauses.push(`${alias}.lng BETWEEN @bw AND @be AND ${alias}.lat BETWEEN @bs AND @bn`);
  }
  return { sql: clauses.length ? `AND ${clauses.join(" AND ")}` : "", params };
}

const RESULT_COLUMNS = `
  a.id, a.authority_id, a.planning_reference, a.description, a.status,
  a.application_type, a.is_domestic_guess, a.received_date, a.decision,
  a.decision_date, a.address_text, a.lat, a.lng
`;

export function search(
  db: Database.Database,
  f: SearchFilters
): { results: SearchResultRow[]; total: number; fuzzy: boolean } {
  const limit = Math.min(Math.max(f.limit ?? 25, 1), 200);
  const page = Math.max(f.page ?? 1, 1);
  const offset = (page - 1) * limit;
  const where = buildWhere(f);

  let rows: SearchResultRow[] = [];
  let total = 0;
  let fuzzy = false;

  if (f.q?.trim()) {
    const ftsQuery = buildFtsQuery(f.q);
    if (ftsQuery) {
      ({ rows, total } = runFtsSearch(db, "fts_apps", ftsQuery, where, limit, offset));
    }
    if (rows.length === 0) {
      // No exact/prefix hits: fall back to trigram matching so typos still land.
      const triQuery = buildTrigramQuery(f.q);
      if (triQuery) {
        ({ rows, total } = runFtsSearch(db, "fts_tri", triQuery, where, limit, offset));
        fuzzy = rows.length > 0;
        rows.forEach((r) => (r.match_quality = "fuzzy"));
      }
    } else {
      rows.forEach((r) => (r.match_quality = "exact"));
    }
  } else {
    const orderBy = orderClause(f.sort ?? "received");
    total = (
      db
        .prepare(`SELECT COUNT(*) AS c FROM applications a WHERE 1=1 ${where.sql}`)
        .get(where.params) as { c: number }
    ).c;
    rows = db
      .prepare(
        `SELECT ${RESULT_COLUMNS} FROM applications a WHERE 1=1 ${where.sql} ${orderBy} LIMIT @limit OFFSET @offset`
      )
      .all({ ...where.params, limit, offset }) as SearchResultRow[];
  }

  if (f.near) {
    for (const r of rows) {
      if (r.lat != null && r.lng != null) {
        r.distance_km = Math.round(haversineKm(f.near.lat, f.near.lng, r.lat, r.lng) * 100) / 100;
      }
    }
    if (f.sort === "distance") {
      rows.sort((a, b) => (a.distance_km ?? Infinity) - (b.distance_km ?? Infinity));
    }
  }
  return { results: rows, total, fuzzy };
}

function orderClause(sort: NonNullable<SearchFilters["sort"]>): string {
  switch (sort) {
    case "decision":
      return "ORDER BY a.decision_date IS NULL, a.decision_date DESC";
    case "received":
    case "distance": // distance is applied in JS after the query
    case "relevance":
    default:
      return "ORDER BY a.received_date IS NULL, a.received_date DESC";
  }
}

function runFtsSearch(
  db: Database.Database,
  table: "fts_apps" | "fts_tri",
  match: string,
  where: WhereClause,
  limit: number,
  offset: number
): { rows: SearchResultRow[]; total: number } {
  const base = `
    FROM ${table} f
    JOIN applications a ON a.id = f.application_id
    WHERE ${table} MATCH @match ${where.sql}
  `;
  const params = { ...where.params, match };
  const total = (
    db.prepare(`SELECT COUNT(*) AS c ${base}`).get(params) as { c: number }
  ).c;
  const rows = db
    .prepare(
      `SELECT ${RESULT_COLUMNS}, bm25(${table}) AS rank ${base} ORDER BY rank LIMIT @limit OFFSET @offset`
    )
    .all({ ...params, limit, offset }) as SearchResultRow[];
  return { rows, total };
}

/** Autocomplete over addresses and references (PRD F1.3). */
export function suggest(db: Database.Database, q: string, limit = 8): string[] {
  const ftsQuery = buildFtsQuery(q);
  if (!ftsQuery) return [];
  const rows = db
    .prepare(
      `SELECT a.address_text, a.planning_reference
       FROM fts_apps f JOIN applications a ON a.id = f.application_id
       WHERE fts_apps MATCH ? ORDER BY bm25(fts_apps) LIMIT ?`
    )
    .all(ftsQuery, limit * 2) as Array<{ address_text: string | null; planning_reference: string }>;
  const out: string[] = [];
  const seen = new Set<string>();
  for (const r of rows) {
    const candidate = r.address_text?.trim() || r.planning_reference;
    const key = candidate.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      out.push(candidate);
    }
    if (out.length >= limit) break;
  }
  return out;
}
