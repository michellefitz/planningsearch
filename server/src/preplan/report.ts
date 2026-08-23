/**
 * Pre-planner report pipeline: gather every evidence section in parallel,
 * deep-dive the documents behind the strongest precedents, then one
 * synthesis pass writes the considerations narrative. Streamed as events so
 * the UI can show progress; every dep is injected for tests.
 */
import type { DesignationsSection, FloodGroundSection, HeritageSection } from "./point-data.js";
import {
  areaStats,
  selectPrecedents,
  type PrecedentSourceRow,
  type ScoredPrecedent,
} from "./precedents.js";

export interface PreplanInput {
  lat: number;
  lng: number;
  address: string;
  intent: string;
}

export type PreplanEvent =
  | { type: "progress"; step: string }
  | { type: "section"; name: string; data: unknown }
  | { type: "narrative"; text: string }
  | { type: "done"; sections: Record<string, unknown>; narrative: string | null }
  | { type: "error"; message: string };

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

export interface ReportDeps {
  getDesignations(lat: number, lng: number): Promise<DesignationsSection>;
  getHeritagePoints(lat: number, lng: number): Promise<HeritageSection>;
  getFloodGround(lat: number, lng: number): Promise<FloodGroundSection>;
  /** Candidate rows within the precedent radius plus the deciding authority's rows. */
  getRows(
    lat: number,
    lng: number
  ): Promise<{ nearby: PrecedentSourceRow[]; authority: PrecedentSourceRow[]; authority_id?: string | null }>;
  /** One batched call: plain-English summaries keyed by planning_reference, or null. */
  summarisePrecedents?(
    items: Array<{ planning_reference: string; description: string | null }>
  ): Promise<Record<string, string> | null>;
  /** Extract condition themes, appeal details and FI themes from precedent data. */
  extractThemes?(prompt: string, data: string): Promise<string | null>;
  /** One synthesis call; returns the narrative markdown or null. */
  synthesise(packJson: string): Promise<string | null>;
}

/** County development plan landing pages, verified live 2026-07-27. The plan
 *  is the document a proposal is actually judged against — always link it. */
export const LOCAL_PLANS: Record<string, { name: string; url: string }> = {
  "dublin-city": {
    name: "Dublin City Development Plan 2022–2028",
    url: "https://www.dublincity.ie/residential/planning/strategic-planning/dublin-city-development-plan",
  },
  fingal: {
    name: "Fingal Development Plan 2023–2029",
    url: "https://www.fingal.ie/planning",
  },
  dlr: {
    name: "Dún Laoghaire-Rathdown County Development Plan 2022–2028",
    url: "https://www.dlrcoco.ie/planning",
  },
  "south-dublin": {
    name: "South Dublin County Development Plan 2022–2028",
    url: "https://www.sdcc.ie/en/devplan2022/",
  },
  kildare: {
    name: "Kildare County Development Plan 2023–2029",
    url: "https://kildarecoco.ie/AllServices/Planning/DevelopmentPlansLocalAreaPlans/KildareCountyDevelopmentPlan2023-2029/",
  },
};

export const CONDITION_THEMES_PROMPT = `You are analysing nearby planning applications to extract themes for a pre-planning report.

Given an array of nearby planning applications with their descriptions, decisions, and appeal status, extract:

1. "condition_themes" — the 3-6 most common conditions imposed on grants in this area. Each theme has a short label and specific examples citing the application reference and address.

2. "appeal_details" — for each appealed application: what was proposed, what the council decided, what An Coimisiún Pleanála decided, and what changed.

3. "fi_themes" — common types of Further Information requests (what the council asks for before deciding). Each theme has a label, count, and example applications.

Return valid JSON matching this shape:
{
  "condition_themes": [
    { "theme": "Matching external finishes", "examples": [{ "reference": "062690", "address": "19 Glen Easton Gardens", "summary": "External finishes must match existing dwelling" }] }
  ],
  "appeal_details": [
    { "reference": "24134", "address": "19 Glen Easton Gardens", "proposal": "Attic conversion with rear dormer", "council_decision": "Granted with conditions", "appeal_outcome": "Modified — condition 2 removed", "what_changed": "Board found dormer scale acceptable" }
  ],
  "fi_themes": [
    { "theme": "Shadow/daylight analysis", "count": 2, "examples": [{ "reference": "123", "address": "5 Main St" }] }
  ]
}

Only include condition themes with 2+ examples. Be specific — cite actual conditions, not vague categories. If there are no appeals or F.I. requests, return empty arrays for those fields.`;

export const PRECEDENT_SUMMARY_PROMPT = `You are given a JSON array of nearby planning applications, each with a
planning_reference and a description copied verbatim from an Irish planning register.
For each one write a 1-2 sentence plain-English summary of what was applied for —
no legalese, no register boilerplate, no addresses.
Reply with only a JSON object mapping each planning_reference to its summary. No other text.`;

export const AT_A_GLANCE_PROMPT = `Write a 2-3 sentence summary of this property's planning context for a professional reader (solicitor, architect, or homeowner).

Sentence 1: What the zoning allows at this location.
Sentence 2: Any notable constraints — flood risk, heritage designations, RZLT, derelict site status. If none, say so.
Sentence 3: The pattern of nearby planning decisions — are similar works commonly granted? Any notable refusals or appeals?

Be factual and specific. No advice, no predictions, no caveats. Use plain language.`;

export const PREPLAN_SYNTHESIS_PROMPT = `You are writing the "Considerations" section of a pre-planning report for a property in Ireland.
The report already shows site constraints, planning history at the address, nearby precedents grouped by work type, and condition themes with cited examples. Do NOT repeat that information.

Write 200-400 words. Use **bold** headings. Structure:

**What nearby decisions suggest** — what does the pattern of grants, refusals, and appeals mean for someone at this location?

**What to prepare for** — based on condition themes and Further Information patterns, what should an applicant have ready?

If the evidence pack includes an intent, add: **How this relates to the proposed works** — connect the evidence to the stated intent.

Ground every statement in the evidence pack. No generic planning advice.`;

const unavailable = (reason: string) => ({ unavailable: true as const, reason });

export async function* generateReport(input: PreplanInput, deps: ReportDeps): AsyncGenerator<PreplanEvent> {
  const sections: Record<string, unknown> = {};

  yield { type: "progress", step: "Checking designations, heritage and ground conditions…" };

  const rowsPromise = deps.getRows(input.lat, input.lng).catch(() => null);
  const pending = new Map<string, Promise<{ name: string; data: unknown }>>();
  const track = (name: string, p: Promise<unknown>, failReason: string) =>
    pending.set(
      name,
      p.then(
        (data) => ({ name, data }),
        () => ({ name, data: unavailable(failReason) })
      )
    );

  track(
    "site_constraints",
    Promise.all([
      deps.getDesignations(input.lat, input.lng),
      deps.getHeritagePoints(input.lat, input.lng),
      deps.getFloodGround(input.lat, input.lng),
    ]).then(([designations, heritage, flood]) => ({ designations, heritage, flood })),
    "site data services did not respond"
  );

  const ADDRESS_RADIUS_M = 20;
  const precedentsPromise = rowsPromise.then((rows) => {
    if (!rows) throw new Error("rows unavailable");
    return selectPrecedents(rows.nearby, input.lat, input.lng, input.intent);
  });

  track(
    "address_history",
    precedentsPromise.then((items) => ({
      items: items.filter((p) => p.distance_m != null && p.distance_m <= ADDRESS_RADIUS_M),
    })),
    "the planning register could not be searched"
  );
  track(
    "nearby",
    precedentsPromise.then((items) => {
      const nearbyItems = items.filter((p) => p.distance_m == null || p.distance_m > ADDRESS_RADIUS_M);
      const officerCounts = new Map<string, number>();
      for (const p of nearbyItems) {
        if (p.officer_name) officerCounts.set(p.officer_name, (officerCounts.get(p.officer_name) ?? 0) + 1);
      }
      const officers = [...officerCounts.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .map(([name, count]) => ({ name, count }));
      const appeals = nearbyItems
        .filter((p) => p.appeal_reference)
        .map((p) => ({
          reference: p.planning_reference,
          address: p.address_text,
          description: p.description,
          status: p.status,
          appeal_reference: p.appeal_reference,
        }));
      const fi_count = nearbyItems.filter((p) => p.further_info_requested_date).length;
      return { items: nearbyItems, officers, appeals, fi_count, condition_themes: [] as ConditionTheme[], fi_themes: [] as FITheme[] };
    }),
    "the planning register could not be searched"
  );
  track(
    "area_stats",
    rowsPromise.then((rows) => {
      if (!rows) throw new Error("rows unavailable");
      return areaStats(rows.authority, input.lat, input.lng);
    }),
    "area statistics could not be computed"
  );
  track(
    "local_plan",
    rowsPromise.then((rows) => {
      const plan = rows?.authority_id ? LOCAL_PLANS[rows.authority_id] : null;
      if (!plan) throw new Error("no plan known");
      return { authority_id: rows!.authority_id, ...plan };
    }),
    "the local development plan could not be identified"
  );

  while (pending.size) {
    const done = await Promise.race(pending.values());
    pending.delete(done.name);
    sections[done.name] = done.data;
    yield { type: "section", name: done.name, data: done.data };
  }

  // Summarise precedents and extract condition themes across both sections.
  const addressHistory = sections.address_history as { items?: ScoredPrecedent[] } | undefined;
  const nearby = sections.nearby as {
    items?: ScoredPrecedent[];
    condition_themes?: ConditionTheme[];
    appeals?: AppealDetail[];
    fi_themes?: FITheme[];
  } | undefined;
  const allPrecedentItems = [
    ...(Array.isArray(addressHistory?.items) ? addressHistory.items : []),
    ...(Array.isArray(nearby?.items) ? nearby.items : []),
  ];

  if (allPrecedentItems.length) {
    const unsummarised = allPrecedentItems.filter((p) => !p.ai_summary && p.description);
    if (unsummarised.length && deps.summarisePrecedents) {
      yield { type: "progress", step: "Summarising the nearby applications…" };
      try {
        const summaries = await deps.summarisePrecedents(
          unsummarised.map((p) => ({ planning_reference: p.planning_reference, description: p.description }))
        );
        for (const p of unsummarised) {
          const s = summaries?.[p.planning_reference];
          if (typeof s === "string" && s.trim()) p.ai_summary = s.trim();
        }
        yield { type: "section", name: "address_history", data: addressHistory };
        yield { type: "section", name: "nearby", data: nearby };
      } catch {
        // Raw descriptions still render; a failed summary batch only costs polish.
      }
    }

    if (deps.extractThemes) {
      yield { type: "progress", step: "Extracting condition themes from nearby decisions…" };
      try {
        const evidencePack = allPrecedentItems
          .filter((p) => p.status !== "invalid" && p.status !== "incomplete")
          .map((p) => ({
            reference: p.planning_reference,
            address: p.address_text,
            description: p.ai_summary ?? p.description,
            status: p.status,
            decision: p.decision,
            decision_date: p.decision_date,
            appeal_reference: p.appeal_reference ?? null,
            further_info_requested: Boolean(p.further_info_requested_date),
            officer_name: p.officer_name ?? null,
          }));
        const raw = await deps.extractThemes(CONDITION_THEMES_PROMPT, JSON.stringify(evidencePack));
        if (raw) {
          const match = raw.match(/\{[\s\S]*\}/);
          if (match) {
            const parsed = JSON.parse(match[0]) as {
              condition_themes?: ConditionTheme[];
              appeal_details?: AppealDetail[];
              fi_themes?: FITheme[];
            };
            if (nearby) {
              if (Array.isArray(parsed.condition_themes)) nearby.condition_themes = parsed.condition_themes;
              if (Array.isArray(parsed.appeal_details)) nearby.appeals = parsed.appeal_details;
              if (Array.isArray(parsed.fi_themes)) nearby.fi_themes = parsed.fi_themes;
              sections.nearby = nearby;
            }
          }
        }
      } catch {
        // Theme extraction is additive; the report still works without it.
      }
    }
    yield { type: "section", name: "nearby", data: nearby };
  }

  // At a glance: a 2-3 sentence summary from the resolved sections.
  if (deps.extractThemes) {
    yield { type: "progress", step: "Writing the at-a-glance summary…" };
    try {
      const glancePack = {
        designations: (sections.site_constraints as { designations?: { items?: unknown[] } })?.designations?.items ?? [],
        flood: (sections.site_constraints as { flood?: unknown })?.flood,
        precedent_count: ((sections.address_history as { items?: unknown[] })?.items?.length ?? 0) +
          ((sections.nearby as { items?: unknown[] })?.items?.length ?? 0),
        grant_rate: (sections.area_stats as { within_2km?: { grant_rate?: number } })?.within_2km?.grant_rate,
        appeals: (sections.nearby as { appeals?: unknown[] })?.appeals?.length ?? 0,
      };
      const glanceText = await deps.extractThemes(AT_A_GLANCE_PROMPT, JSON.stringify(glancePack));
      if (glanceText) {
        sections.at_a_glance = glanceText;
        yield { type: "section", name: "at_a_glance", data: glanceText };
      }
    } catch {
      // At a glance is additive; the report still works without it.
    }
  }

  yield { type: "progress", step: "Writing the considerations…" };
  let narrative: string | null = null;
  try {
    narrative = await deps.synthesise(
      JSON.stringify({ intent: input.intent, address: input.address, sections })
    );
  } catch {
    narrative = null;
  }
  if (narrative) yield { type: "narrative", text: narrative };

  yield { type: "done", sections, narrative };
}
