export interface Authority {
  id: string;
  name: string;
  short_name: string;
  source_system: string;
  portal_base_url: string;
  gis_url: string | null;
  last_synced: string | null;
  application_count: number;
  /** Earliest application we hold for this council — its register depth. */
  earliest_received: string | null;
}

export interface Meta {
  authorities: Authority[];
  source_updated_at: string | null;
  generated_at: string | null;
  statuses: Record<string, string>;
  application_types: Record<string, string>;
  glossary: Record<string, string>;
  attribution: string;
}

export interface AppSummary {
  id: number;
  authority_id: string;
  authority_name: string;
  authority_short_name: string;
  planning_reference: string;
  description: string | null;
  status: string;
  status_label: string;
  application_type: string;
  application_type_label: string;
  is_domestic_guess: boolean;
  received_date: string | null;
  decision: string | null;
  decision_date: string | null;
  address_text: string | null;
  lat: number | null;
  lng: number | null;
  distance_km?: number;
  match_quality?: "exact" | "fuzzy";
  /** Residential unit count — feed field or extracted from the description. */
  num_residential_units?: number | null;
  portal_url: string | null;
  commencement_date?: string | null;
  completion_date?: string | null;
  /** Present on search rows too (RESULT_COLUMNS) — drives the "Appealed" pill. */
  appeal_reference?: string | null;
  /** Deep link to the An Coimisiún Pleanála case file when an appeal exists. */
  appeal_url?: string | null;
}

export interface AppDetail extends AppSummary {
  ai_summary: string | null;
  status_raw: string | null;
  application_type_raw: string | null;
  validated_date: string | null;
  further_info_requested_date: string | null;
  further_info_received_date: string | null;
  decision_due_date: string | null;
  submissions_by_date: string | null;
  appeal_status: string | null;
  appeal_reference: string | null;
  appeal_lodged_date: string | null;
  appeal_decision: string | null;
  appeal_decision_date: string | null;
  final_grant_date: string | null;
  applicant_name: string | null;
  agent_name: string | null;
  /** Case officer, baked in from the nightly agile-portal harvest. */
  officer_name?: string | null;
  eircode: string | null;
  num_residential_units: number | null;
  floor_area_sqm: number | null;
  site_area_ha: number | null;
  expiry_date: string | null;
  ppr_sales?: Array<{
    date: string;
    price: number;
    description: string | null;
    vat_exclusive: boolean;
    not_full_market: boolean;
  }>;
  source_url: string | null;
  scanned_files_url: string | null;
  /** Deep link to the An Coimisiún Pleanála case file when an appeal exists. */
  appeal_url: string | null;
  /** BCMS commencement notice joined by permission number (data.nbco.gov.ie). */
  commencement_notice?: string | null;
  commencement_units?: number | null;
  commencement_count?: number | null;
  /** Agile portals: route the portal button through /api/applications/:id/portal. */
  portal_resolver: boolean;
  files_supported: boolean;
  last_synced: string | null;
  documents: Array<{
    id: number;
    title: string;
    doc_type: string | null;
    page_count: number | null;
    access_mode: "link" | "cached";
    source_url: string | null;
    is_withheld: number;
  }>;
  related: Array<{
    id: number;
    planning_reference: string;
    description: string | null;
    status: string;
    received_date: string | null;
    decision_date: string | null;
  }>;
}

export interface ConditionItem {
  code: string;
  code_label: string;
  title: string;
  text: string;
  order: number;
}

export interface DecisionConditions {
  decision: string | null;
  decision_date: string | null;
  items: ConditionItem[];
  refusal_summary?: string | null;
}

export interface ZoningInfo {
  zone: string;
  general: string | null;
  objective: string | null;
  plan: string | null;
  plan_level: string | null;
  plan_url: string | null;
}

export interface SearchState {
  q: string;
  authorities: string[];
  statuses: string[];
  types: string[];
  domesticOnly: boolean;
  oneOffOnly: boolean;
  appealedOnly: boolean;
  commencedOnly: boolean;
  receivedFrom: string;
  receivedTo: string;
  /** Minimum residential units ("development size"); 0 = any. */
  minUnits: number;
  useMapArea: boolean;
  sort: string;
}

/** Options for the development-size filter, smallest to largest. */
export const MIN_UNITS_OPTIONS: Array<{ value: number; label: string }> = [
  { value: 0, label: "Any size" },
  { value: 10, label: "10+ homes" },
  { value: 50, label: "50+ homes" },
  { value: 100, label: "100+ homes" },
];

// Canonical status keys, kept in step with STATUS_STYLE (MapView). "invalid"
// and "incomplete" are noise for most users (applications that never proceeded),
// so they're hidden by default — but they stay as toggleable Status chips, so
// the default selection is every status except those two.
export const HIDDEN_BY_DEFAULT_STATUSES = ["invalid", "incomplete"];
export const DEFAULT_STATUSES = [
  "pending",
  "further_info",
  "granted",
  "refused",
  "withdrawn",
  "appealed",
  "split",
  "exempt",
  "not_exempt",
  "decided",
  "unknown",
];

export const EMPTY_SEARCH: SearchState = {
  q: "",
  authorities: [],
  statuses: [...DEFAULT_STATUSES],
  types: [],
  domesticOnly: false,
  oneOffOnly: false,
  appealedOnly: false,
  commencedOnly: false,
  receivedFrom: "",
  receivedTo: "",
  minUnits: 0,
  useMapArea: false,
  // Relevance by default: with a keyword it means best-match-first, and with no
  // keyword both backends fall through to newest-first. Defaulting to "received"
  // made every keyword search date-ordered, burying the thing you searched for.
  sort: "relevance",
};

export function searchParams(
  s: SearchState,
  bbox: [number, number, number, number] | null,
  near: { lat: number; lng: number } | null
): URLSearchParams {
  const p = new URLSearchParams();
  if (s.q.trim()) p.set("q", s.q.trim());
  if (s.authorities.length) p.set("authority", s.authorities.join(","));
  if (s.statuses.length) p.set("status", s.statuses.join(","));
  if (s.types.length) p.set("type", s.types.join(","));
  if (s.domesticOnly) p.set("domestic", "1");
  if (s.oneOffOnly) p.set("one_off", "1");
  if (s.appealedOnly) p.set("appealed", "1");
  if (s.commencedOnly) p.set("commenced", "1");
  if (s.receivedFrom) p.set("receivedFrom", s.receivedFrom);
  if (s.receivedTo) p.set("receivedTo", s.receivedTo);
  if (s.minUnits) p.set("minUnits", String(s.minUnits));
  if (s.useMapArea && bbox) p.set("bbox", bbox.join(","));
  if (near) {
    p.set("lat", String(near.lat));
    p.set("lng", String(near.lng));
  }
  if (s.sort) p.set("sort", s.sort);
  p.set("limit", "50");
  return p;
}

/**
 * Params for the map layer. Same filters as the list, but the bbox is *always*
 * the current viewport — the "Limit to current map area" checkbox scopes the
 * list, not the pins. Without this the map fetched every matching application
 * in the country on every search, which since the 2012 backfill is ~94k
 * features and tens of megabytes.
 */
export function mapParams(
  s: SearchState,
  bbox: [number, number, number, number] | null,
  near: { lat: number; lng: number } | null
): URLSearchParams {
  const p = searchParams(s, bbox, near);
  p.delete("limit");
  if (bbox) p.set("bbox", bbox.join(","));
  return p;
}

/** One date voice for display: "2026-05-12" → "12 May 2026". Anything that
    isn't an ISO date passes through untouched. Inputs keep ISO. */
export function fmtDate(iso: string | null | undefined): string {
  if (!iso || !/^\d{4}-\d{2}-\d{2}/.test(iso)) return iso ?? "";
  return new Date(`${iso.slice(0, 10)}T00:00:00`).toLocaleDateString("en-IE", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return res.json() as Promise<T>;
}

export interface PointFeatureCollection {
  type: "FeatureCollection";
  features: Array<{
    type: "Feature";
    geometry: { type: "Point"; coordinates: [number, number] };
    properties: Record<string, unknown>;
  }>;
  /** Located applications matching the filters in this viewport. */
  matched?: number;
  /** True when more matched than were returned — the map is showing a subset. */
  truncated?: boolean;
}

export const api = {
  meta: () => getJson<Meta>("/api/meta"),
  search: (p: URLSearchParams) =>
    getJson<{ total: number; fuzzy: boolean; results: AppSummary[] }>(`/api/search?${p}`),
  suggest: (q: string) =>
    getJson<{ suggestions: string[] }>(`/api/suggest?q=${encodeURIComponent(q)}`),
  detail: (id: number) => getJson<AppDetail>(`/api/applications/${id}`),
  related: (id: number) =>
    getJson<{
      supported: boolean;
      related: Array<{
        id: number | null;
        planning_reference: string;
        description: string | null;
        address: string | null;
        received_date: string | null;
        status: string | null;
        eplanning_url: string;
      }>;
    }>(`/api/applications/${id}/related`),
  files: (id: number) =>
    getJson<{
      supported: boolean;
      direct?: boolean;
      list_url: string | null;
      files: Array<{ title: string; url: string }> | null;
      objection_count: number | null;
    }>(`/api/applications/${id}/files`),
  enrich: (id: number) =>
    getJson<{
      ai_summary: string | null;
      applicant_name: string | null;
      agent_name: string | null;
      description?: string | null;
      eircode?: string | null;
      officer_name?: string | null;
      status?: string | null;
      status_raw?: string | null;
      status_label?: string | null;
    }>(`/api/applications/${id}/enrich`),
  zoning: (id: number) =>
    getJson<{ supported: boolean; zones: ZoningInfo[] | null }>(
      `/api/applications/${id}/zoning`
    ),
  conditions: (id: number) =>
    getJson<{ supported: boolean; conditions: DecisionConditions | null }>(
      `/api/applications/${id}/conditions`
    ),
  refusalSummary: (id: number) =>
    getJson<{ supported: boolean; summary: string | null }>(
      `/api/applications/${id}/refusal-summary`
    ),
  appeal: (id: number) =>
    getJson<{
      supported: boolean;
      case_url?: string;
      reference?: string | null;
      status?: string | null;
      lodged_date?: string | null;
      decision?: string | null;
      decision_date?: string | null;
      fields?: Array<{ label: string; value: string }> | null;
      documents?: Array<{ title: string; url: string }> | null;
    }>(`/api/applications/${id}/appeal`),
  appealSummary: (id: number) =>
    getJson<{
      supported: boolean;
      summary?: string | null;
      based_on_document?: string | null;
    }>(`/api/applications/${id}/appeal-summary`),
  decisionSummary: (id: number) =>
    getJson<{
      supported: boolean;
      summary?: string | null;
      source_document?: string | null;
      conditions?: Array<{ number: number | null; title: string; text: string }>;
      reasons?: Array<{ number: number | null; text: string }>;
    }>(`/api/applications/${id}/decision-summary`),
  mapGeoJson: (p: URLSearchParams) =>
    getJson<PointFeatureCollection>(`/api/map/applications?${p}`),
  mapPolygons: (p: URLSearchParams) =>
    getJson<GeoJSON.FeatureCollection>(`/api/map/polygons?${p}`),
  resolve: (authority: string, reference: string) =>
    getJson<{ id: number }>(
      `/api/resolve?authority=${encodeURIComponent(authority)}&reference=${encodeURIComponent(reference)}`
    ),
  overlay: (layer: "zoning" | "conservation" | "archaeology", bbox: [number, number, number, number]) =>
    getJson<GeoJSON.FeatureCollection>(`/api/overlays/${layer}?bbox=${bbox.join(",")}`),
};
