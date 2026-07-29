import type Database from "better-sqlite3";

export interface SearchFilters {
  q?: string;
  authorities?: string[];
  statuses?: string[];
  types?: string[];
  domesticOnly?: boolean;
  appealedOnly?: boolean;
  commencedOnly?: boolean;
  /** Statuses to drop (e.g. invalid/incomplete junk) — applied as NOT IN. */
  excludeStatuses?: string[];
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
  appeal_reference: string | null;
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

/**
 * Does this query look like a planning reference — "3456/25", "D25A/0123",
 * "WEB1234/25", "211277", "ABP-319506-23"?
 *
 * Reference-shaped queries must never fall back to fuzzy matching: a "close
 * match" on a reference is a *different property*, and someone who typed a
 * reference wants that file or nothing. Better to return no results than a
 * plausible-looking wrong one.
 */
export function looksLikeReference(q: string): boolean {
  const s = q.trim();
  if (!s || /\s/.test(s)) return false;
  if (!/^[A-Za-z0-9/\-.]+$/.test(s)) return false;
  return (s.match(/\d/g)?.length ?? 0) >= 2;
}

/**
 * A full or partial Eircode — "W23 Y2W8", "W23Y2W8", or a bare routing key
 * ("W23", "D15", "D6W").
 *
 * These need the same protection as a planning reference. An Eircode
 * identifies one property, so a trigram "close match" is always a *different*
 * address: "W23 Y2W8" fuzzy-matched a D15 property, and the bare key "W23"
 * false-hit "FW23B"-style references. Someone typing an Eircode wants that
 * property or a clear nothing.
 */
export function looksLikeEircode(q: string): boolean {
  const s = q.trim().toUpperCase().replace(/\s+/g, "");
  if (!/^[A-Z0-9]+$/.test(s)) return false;
  const routingKey = /^(D6W|[A-Z]\d{2})/;
  if (!routingKey.test(s)) return false;
  // Routing key alone, or the full 7-character code.
  return s.length === 3 || s.length === 7;
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
  if (f.excludeStatuses?.length) {
    const keys = f.excludeStatuses.map((v, i) => {
      params[`ex${i}`] = v;
      return `@ex${i}`;
    });
    clauses.push(`${alias}.status NOT IN (${keys.join(",")})`);
  }
  if (f.domesticOnly) clauses.push(`${alias}.is_domestic_guess = 1`);
  if (f.appealedOnly) clauses.push(`${alias}.appeal_reference IS NOT NULL`);
  if (f.commencedOnly) clauses.push(`${alias}.commencement_date IS NOT NULL`);
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
  a.decision_date, a.appeal_reference, a.address_text, a.lat, a.lng,
  a.commencement_date, a.completion_date
`;

// When sorting by distance we fetch a wide candidate pool (bbox-bounded) and
// pick the nearest N in JS, so "nearest" is truly the nearest — not just the
// nearest within a small page ordered by date/relevance.
const DISTANCE_POOL = 3000;

export function search(
  db: Database.Database,
  f: SearchFilters
): { results: SearchResultRow[]; total: number; fuzzy: boolean } {
  // 200 is the ceiling for list pages; the map layer asks for more because a
  // pin is a fraction of a result row and a 200-pin map looks empty over a
  // city. MAP_FEATURE_LIMIT is the real bound on that path.
  const limit = Math.min(Math.max(f.limit ?? 25, 1), 2000);
  const page = Math.max(f.page ?? 1, 1);
  const distanceMode = f.sort === "distance" && !!f.near;
  // In distance mode, pull the whole (bbox-limited) set and rank by distance
  // ourselves; otherwise page normally.
  const fetchLimit = distanceMode ? DISTANCE_POOL : limit;
  const offset = distanceMode ? 0 : (page - 1) * limit;
  const where = buildWhere(f);

  let rows: SearchResultRow[] = [];
  let total = 0;
  let fuzzy = false;

  if (f.q?.trim()) {
    const sort = f.sort ?? "relevance";
    const ftsQuery = buildFtsQuery(f.q);
    if (ftsQuery) {
      ({ rows, total } = runFtsSearch(db, "fts_apps", ftsQuery, where, fetchLimit, offset, sort));
    }
    if (rows.length === 0 && !looksLikeReference(f.q) && !looksLikeEircode(f.q)) {
      // No exact/prefix hits: fall back to trigram matching so typos still land.
      // Not for reference- or Eircode-shaped queries though — a "close match" on
      // either means a different property, which is worse than no answer.
      const triQuery = buildTrigramQuery(f.q);
      if (triQuery) {
        ({ rows, total } = runFtsSearch(db, "fts_tri", triQuery, where, fetchLimit, offset, sort));
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
      .all({ ...where.params, limit: fetchLimit, offset }) as SearchResultRow[];
  }

  if (f.near) {
    for (const r of rows) {
      if (r.lat != null && r.lng != null) {
        r.distance_km = Math.round(haversineKm(f.near.lat, f.near.lng, r.lat, r.lng) * 100) / 100;
      }
    }
    if (distanceMode) {
      rows.sort((a, b) => (a.distance_km ?? Infinity) - (b.distance_km ?? Infinity));
      rows = rows.slice(0, limit); // the true nearest N
    }
  }
  return { results: rows, total, fuzzy };
}

export interface AreaAggregate {
  total: number;
  /** Counts per planning authority — a boundary-spanning radius mixes councils
   *  that decide independently, so the agent breaks results down by authority. */
  by_authority: Record<string, number>;
  by_status: Record<string, number>;
  by_type: Record<string, number>;
  by_year: Record<string, number>;
  domestic: number;
  commenced: number;
  appealed: number;
  granted: number;
  refused: number;
}

function groupCount(
  db: Database.Database,
  sql: string,
  params: Record<string, unknown>
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const r of db.prepare(sql).all(params) as Array<{ k: string | null; c: number }>) {
    if (r.k != null && String(r.k).length) out[String(r.k)] = r.c;
  }
  return out;
}

/**
 * Counts and breakdowns over the ENTIRE matching set (no result cap), so the
 * agent can report the true size of the set and compute rates from all of it
 * rather than from a sample.
 */
export function aggregateApplications(db: Database.Database, f: SearchFilters): AreaAggregate {
  const where = buildWhere(f);
  const ftsQuery = f.q?.trim() ? buildFtsQuery(f.q) : null;
  let base: string;
  let params: Record<string, unknown>;
  if (ftsQuery) {
    base = `FROM fts_apps ff JOIN applications a ON a.id = ff.application_id WHERE fts_apps MATCH @match ${where.sql}`;
    params = { ...where.params, match: ftsQuery };
  } else {
    base = `FROM applications a WHERE 1=1 ${where.sql}`;
    params = where.params;
  }
  const totals = db
    .prepare(
      `SELECT COUNT(*) AS total,
        SUM(CASE WHEN a.is_domestic_guess = 1 THEN 1 ELSE 0 END) AS domestic,
        SUM(CASE WHEN a.commencement_date IS NOT NULL THEN 1 ELSE 0 END) AS commenced,
        SUM(CASE WHEN a.appeal_reference IS NOT NULL THEN 1 ELSE 0 END) AS appealed,
        SUM(CASE WHEN a.status = 'granted' THEN 1 ELSE 0 END) AS granted,
        SUM(CASE WHEN a.status = 'refused' THEN 1 ELSE 0 END) AS refused
       ${base}`
    )
    .get(params) as Record<string, number>;
  return {
    total: totals.total ?? 0,
    by_authority: groupCount(db, `SELECT a.authority_id AS k, COUNT(*) AS c ${base} GROUP BY a.authority_id`, params),
    by_status: groupCount(db, `SELECT a.status AS k, COUNT(*) AS c ${base} GROUP BY a.status`, params),
    by_type: groupCount(db, `SELECT a.application_type AS k, COUNT(*) AS c ${base} GROUP BY a.application_type`, params),
    by_year: groupCount(db, `SELECT substr(a.received_date, 1, 4) AS k, COUNT(*) AS c ${base} GROUP BY substr(a.received_date, 1, 4)`, params),
    domestic: totals.domestic ?? 0,
    commenced: totals.commenced ?? 0,
    appealed: totals.appealed ?? 0,
    granted: totals.granted ?? 0,
    refused: totals.refused ?? 0,
  };
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

/**
 * Relevance weights for the four indexed columns (reference, address, applicant,
 * description). Unweighted BM25 normalises by document length, so the shortest
 * record wins and a passing mention of a road in a long description outranks the
 * property actually on that road. A reference match should beat an address
 * match, which should beat an applicant, which should beat a description.
 */
const BM25_RANK: Record<"fts_apps" | "fts_tri", string> = {
  fts_apps: "bm25(fts_apps, 12.0, 8.0, 4.0, 1.0)",
  fts_tri: "bm25(fts_tri)", // single haystack column — nothing to weight
};

/**
 * Ordering for a keyword search. Relevance is the default because the user is
 * searching for something; an explicit date choice is honoured, with relevance
 * as the tiebreak so equal-dated rows still come back best-first.
 */
function ftsOrderClause(
  table: "fts_apps" | "fts_tri",
  sort: NonNullable<SearchFilters["sort"]>
): string {
  const rank = BM25_RANK[table];
  switch (sort) {
    case "decision":
      return `ORDER BY a.decision_date IS NULL, a.decision_date DESC, ${rank}`;
    case "received":
      return `ORDER BY a.received_date IS NULL, a.received_date DESC, ${rank}`;
    case "distance": // applied in JS once coordinates are known
    case "relevance":
    default:
      return `ORDER BY ${rank}`;
  }
}

function runFtsSearch(
  db: Database.Database,
  table: "fts_apps" | "fts_tri",
  match: string,
  where: WhereClause,
  limit: number,
  offset: number,
  sort: NonNullable<SearchFilters["sort"]>
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
      `SELECT ${RESULT_COLUMNS}, ${BM25_RANK[table]} AS rank ${base} ` +
        `${ftsOrderClause(table, sort)} LIMIT @limit OFFSET @offset`
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
