/**
 * Precedent selection and area statistics for the pre-planner. Pure
 * functions over application rows — no IO, callers supply the rows.
 */
import { haversineMeters } from "./geo.js";

export interface PrecedentSourceRow {
  authority_id: string;
  planning_reference: string;
  description: string | null;
  status: string | null;
  decision: string | null;
  decision_date: string | null;
  received_date: string | null;
  address_text: string | null;
  lat: number | null;
  lng: number | null;
  appeal_reference?: string | null;
  appeal_decision?: string | null;
}

export interface ScoredPrecedent extends PrecedentSourceRow {
  distance_m: number;
  score: number;
  keyword_hits: string[];
}

const STOPWORDS = new Set([
  "with", "that", "this", "from", "into", "onto", "over", "under", "have",
  "want", "would", "like", "build", "building", "house", "home", "property",
  "site", "planning", "permission", "application", "works", "existing",
  "proposed", "construction", "construct", "development",
]);

export function intentTokens(intent: string): string[] {
  return [
    ...new Set(
      intent
        .toLowerCase()
        .split(/[^a-z]+/)
        .filter((w) => w.length > 3 && !STOPWORDS.has(w))
    ),
  ];
}

export const PRECEDENT_RADIUS_M = 1000;

export function scorePrecedent(row: PrecedentSourceRow, tokens: string[], distM: number): { score: number; hits: string[] } {
  const desc = (row.description ?? "").toLowerCase();
  const hits = tokens.filter((t) => desc.includes(t));
  return { score: hits.length * 2 + (1 - distM / PRECEDENT_RADIUS_M), hits };
}

export function selectPrecedents(
  rows: PrecedentSourceRow[],
  lat: number,
  lng: number,
  intent: string,
  limit = 8
): ScoredPrecedent[] {
  const tokens = intentTokens(intent);
  const scored: ScoredPrecedent[] = [];
  for (const row of rows) {
    if (row.lat == null || row.lng == null) continue;
    const distance_m = Math.round(haversineMeters(lat, lng, row.lat, row.lng));
    if (distance_m > PRECEDENT_RADIUS_M) continue;
    const { score, hits } = scorePrecedent(row, tokens, distance_m);
    scored.push({ ...row, distance_m, score, keyword_hits: hits });
  }
  return scored.sort((a, b) => b.score - a.score).slice(0, limit);
}

/** Decided or appealed precedents worth reading documents for; appeals first. */
export function deepDiveCandidates(precedents: ScoredPrecedent[], max = 3): ScoredPrecedent[] {
  const decided = precedents.filter((p) => p.decision || p.appeal_reference);
  return decided
    .sort((a, b) => Number(Boolean(b.appeal_reference)) - Number(Boolean(a.appeal_reference)) || b.score - a.score)
    .slice(0, max);
}

export interface RateBlock {
  total: number;
  decided: number;
  granted: number;
  refused: number;
  grant_rate: number | null;
  appealed: number;
  median_decision_days: number | null;
}

export interface AreaStatsSection {
  authority: RateBlock;
  within_2km: RateBlock;
}

const GRANT_RE = /grant|conditional|approve/i;
const REFUSE_RE = /refus|reject/i;

function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : Math.round((s[mid - 1] + s[mid]) / 2);
}

function rateBlock(rows: PrecedentSourceRow[]): RateBlock {
  let granted = 0;
  let refused = 0;
  let appealed = 0;
  const days: number[] = [];
  for (const r of rows) {
    if (r.decision && GRANT_RE.test(r.decision)) granted++;
    else if (r.decision && REFUSE_RE.test(r.decision)) refused++;
    if (r.appeal_reference) appealed++;
    if (r.received_date && r.decision_date) {
      const d = (Date.parse(r.decision_date) - Date.parse(r.received_date)) / 86_400_000;
      if (d >= 0 && d < 1500) days.push(Math.round(d));
    }
  }
  const decided = granted + refused;
  return {
    total: rows.length,
    decided,
    granted,
    refused,
    grant_rate: decided ? Math.round((granted / decided) * 100) : null,
    appealed,
    median_decision_days: median(days),
  };
}

export function areaStats(
  authorityRows: PrecedentSourceRow[],
  lat: number,
  lng: number
): AreaStatsSection {
  const near = authorityRows.filter(
    (r) => r.lat != null && r.lng != null && haversineMeters(lat, lng, r.lat, r.lng) <= 2000
  );
  return { authority: rateBlock(authorityRows), within_2km: rateBlock(near) };
}
