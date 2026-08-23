/** Client for the account-gated pre-planner API. */

export interface PreplanProject {
  id: number;
  label: string;
  lat: number;
  lng: number;
  address: string;
  eircode: string | null;
  intent: string | null;
  created_at: string;
  latest_report_id: number | null;
  latest_report_status: string | null;
  latest_report_at: string | null;
}

export interface PreplanReportRow {
  id: number;
  project_id: number;
  status: string;
  generated_at: string;
}

export interface DesignationHit {
  kind: string;
  name: string;
  detail: string;
  meaning: string;
}

export interface Unavailable {
  unavailable: true;
  reason: string;
}

export interface HeritageItem {
  ref: string;
  name: string;
  distance_m: number | null;
  detail: string;
  notes?: string;
  url?: string;
}

export interface PrecedentItem {
  id?: number;
  authority_id: string;
  planning_reference: string;
  description: string | null;
  ai_summary?: string | null;
  status_label?: string | null;
  source_url?: string | null;
  status: string | null;
  decision: string | null;
  decision_date: string | null;
  received_date?: string | null;
  address_text: string | null;
  lat?: number | null;
  lng?: number | null;
  distance_m: number;
  keyword_hits: string[];
  appeal_reference?: string | null;
  appeal_decision?: string | null;
  work_type?: string;
  officer_name?: string | null;
  commencement_date?: string | null;
  completion_date?: string | null;
  further_info_requested_date?: string | null;
  score?: number;
}

export interface ConditionThemeExample {
  reference: string;
  address: string;
  summary: string;
}
export interface ConditionTheme {
  theme: string;
  examples: ConditionThemeExample[];
}
export interface AppealDetail {
  reference: string;
  address: string;
  proposal: string;
  council_decision: string;
  appeal_outcome: string;
  what_changed: string;
}
export interface FIThemeExample {
  reference: string;
  address: string;
}
export interface FITheme {
  theme: string;
  count: number;
  examples: FIThemeExample[];
}

export interface DeepDive {
  planning_reference: string;
  authority_id: string;
  document: string;
  extract: string;
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

export interface SiteConstraints {
  designations: { items: DesignationHit[]; checked: string[]; failed: string[] };
  heritage: { niah: HeritageItem[] | Unavailable; smr: HeritageItem[] | Unavailable };
  flood: {
    flood: { at_risk: boolean; scenarios: string[] } | Unavailable;
    groundwater: { category: string; description: string; meaning: string } | null | Unavailable;
    radon: Unavailable;
  };
}

export interface NearbySection {
  items: PrecedentItem[];
  officers: Array<{ name: string; count: number }>;
  appeals: AppealDetail[];
  fi_count: number;
  condition_themes: ConditionTheme[];
  fi_themes: FITheme[];
}

export interface ReportSections {
  /** New merged section — designations + heritage + flood in one object. */
  site_constraints?: SiteConstraints | Unavailable;
  /** Applications at the exact address (within 20m). */
  address_history?: { items: PrecedentItem[] } | Unavailable;
  /** Nearby applications (beyond 20m) with enrichments. */
  nearby?: NearbySection | Unavailable;
  /** AI-generated 2-3 sentence summary. */
  at_a_glance?: string;

  /** Legacy keys for backward compatibility. */
  designations?: { items: DesignationHit[]; checked: string[]; failed: string[] } | Unavailable;
  heritage_points?: { niah: HeritageItem[] | Unavailable; smr: HeritageItem[] | Unavailable } | Unavailable;
  flood_ground?:
    | {
        flood: { at_risk: boolean; scenarios: string[] } | Unavailable;
        groundwater: { category: string; description: string; meaning: string } | null | Unavailable;
        radon: Unavailable;
      }
    | Unavailable;
  precedents?: { items: PrecedentItem[]; deep_dives: DeepDive[] } | Unavailable;

  area_stats?: { authority: RateBlock; within_2km: RateBlock } | Unavailable;
  local_plan?: { authority_id: string; name: string; url: string } | Unavailable;
  /** Only present when the proposal is to build a house on a site. */
  rural_housing?: {
    rates: { radius_m: number; within_radius: RateBlock; authority_one_off: RateBlock; authority_all: RateBlock };
    reasons_read: number;
    themes: Array<{ key: string; label: string; count: number; of: number }>;
    local_need_quote: string | null;
    decisions: Array<{
      planning_reference: string;
      authority_id: string;
      distance_m: number;
      decision_date: string | null;
      source: string;
      themes: string[];
    }>;
  };
}

export interface PreplanReport {
  id: number;
  project_id: number;
  status: string;
  sections: ReportSections | null;
  narrative: string | null;
  error: string | null;
  generated_at: string;
  label: string;
  address: string;
  eircode: string | null;
  intent: string | null;
  lat: number;
  lng: number;
}

export type PreplanEvent =
  | { type: "progress"; step: string }
  | { type: "section"; name: string; data: unknown }
  | { type: "narrative"; text: string }
  | { type: "done"; sections: ReportSections; narrative: string | null; report_id?: number }
  | { type: "error"; message: string };

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()) as T;
}

export const preplanApi = {
  projects: () =>
    fetch("/api/preplan/projects", { credentials: "same-origin" }).then((r) =>
      json<{ projects: PreplanProject[]; reports: PreplanReportRow[] }>(r)
    ),

  createProject: (p: { label: string; lat: number; lng: number; address: string; eircode?: string | null; intent?: string | null }) =>
    fetch("/api/preplan/projects", {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(p),
    }).then((r) => json<{ project: PreplanProject }>(r)),

  deleteProject: (id: number) =>
    fetch(`/api/preplan/projects/${id}`, { method: "DELETE", credentials: "same-origin" }).then((r) =>
      json<{ ok: boolean }>(r)
    ),

  report: (id: number) =>
    fetch(`/api/preplan/reports/${id}`, { credentials: "same-origin" }).then((r) =>
      json<{ report: PreplanReport }>(r)
    ),

  async generate(projectId: number, onEvent: (ev: PreplanEvent) => void, signal?: AbortSignal): Promise<void> {
    const res = await fetch(`/api/preplan/projects/${projectId}/reports`, {
      method: "POST",
      credentials: "same-origin",
      signal,
    });
    if (!res.ok || !res.body) throw new Error(`report request failed (${res.status})`);
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf("\n\n")) >= 0) {
        const frame = buf.slice(0, i);
        buf = buf.slice(i + 2);
        const data = frame.split("\n").find((l) => l.startsWith("data: "));
        if (data) onEvent(JSON.parse(data.slice(6)) as PreplanEvent);
      }
    }
  },
};
