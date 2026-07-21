export interface Authority {
  id: string;
  name: string;
  short_name: string;
  source_system: string;
  portal_base_url: string;
  gis_url: string | null;
  last_synced: string | null;
  application_count: number;
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
  portal_url: string | null;
  commencement_date?: string | null;
  completion_date?: string | null;
}

export interface AppDetail extends AppSummary {
  ai_summary: string | null;
  status_raw: string | null;
  application_type_raw: string | null;
  validated_date: string | null;
  further_info_requested_date: string | null;
  further_info_received_date: string | null;
  decision_due_date: string | null;
  appeal_status: string | null;
  appeal_reference: string | null;
  appeal_lodged_date: string | null;
  appeal_decision: string | null;
  appeal_decision_date: string | null;
  final_grant_date: string | null;
  applicant_name: string | null;
  agent_name: string | null;
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
  domesticOnly: boolean;
  appealedOnly: boolean;
  commencedOnly: boolean;
  receivedFrom: string;
  receivedTo: string;
  useMapArea: boolean;
  sort: string;
}

export const EMPTY_SEARCH: SearchState = {
  q: "",
  authorities: [],
  statuses: [],
  domesticOnly: false,
  appealedOnly: false,
  commencedOnly: false,
  receivedFrom: "",
  receivedTo: "",
  useMapArea: false,
  sort: "received",
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
  if (s.domesticOnly) p.set("domestic", "1");
  if (s.appealedOnly) p.set("appealed", "1");
  if (s.commencedOnly) p.set("commenced", "1");
  if (s.receivedFrom) p.set("receivedFrom", s.receivedFrom);
  if (s.receivedTo) p.set("receivedTo", s.receivedTo);
  if (s.useMapArea && bbox) p.set("bbox", bbox.join(","));
  if (near) {
    p.set("lat", String(near.lat));
    p.set("lng", String(near.lng));
  }
  if (s.sort) p.set("sort", s.sort);
  p.set("limit", "50");
  return p;
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
}

export const api = {
  meta: () => getJson<Meta>("/api/meta"),
  search: (p: URLSearchParams) =>
    getJson<{ total: number; fuzzy: boolean; results: AppSummary[] }>(`/api/search?${p}`),
  suggest: (q: string) =>
    getJson<{ suggestions: string[] }>(`/api/suggest?q=${encodeURIComponent(q)}`),
  detail: (id: number) => getJson<AppDetail>(`/api/applications/${id}`),
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
      status?: string | null;
      status_raw?: string | null;
      status_label?: string | null;
    }>(`/api/applications/${id}/enrich`),
  zoning: (id: number) =>
    getJson<{ supported: boolean; zones: ZoningInfo[] | null }>(
      `/api/applications/${id}/zoning`
    ),
  flood: (id: number) =>
    getJson<{
      supported: boolean;
      flood: { at_risk: boolean; scenarios: string[] } | null;
    }>(`/api/applications/${id}/flood`),
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
  overlay: (layer: "zoning" | "flood", bbox: [number, number, number, number]) =>
    getJson<GeoJSON.FeatureCollection>(`/api/overlays/${layer}?bbox=${bbox.join(",")}`),
};
