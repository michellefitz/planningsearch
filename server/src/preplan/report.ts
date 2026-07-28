/**
 * Pre-planner report pipeline: gather every evidence section in parallel,
 * deep-dive the documents behind the strongest precedents, then one
 * synthesis pass writes the considerations narrative. Streamed as events so
 * the UI can show progress; every dep is injected for tests.
 */
import type { DesignationsSection, FloodGroundSection, HeritageSection } from "./point-data.js";
import {
  areaStats,
  deepDiveCandidates,
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

export interface DeepDive {
  planning_reference: string;
  authority_id: string;
  document: string;
  extract: string;
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
  /** Read the most decision-relevant document behind one precedent. Null when nothing readable. */
  readPrecedentDocument(p: ScoredPrecedent, question: string): Promise<{ document: string; answer: string } | null>;
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

export const DEEP_DIVE_QUESTION =
  "Summarise what was decided and why. List the key conditions imposed (or the reasons for refusal), " +
  "and note anything about the site, design or neighbours that drove the outcome.";

export const PREPLAN_SYNTHESIS_PROMPT = `You are writing the "Things to consider" section of a pre-planning research report
for a member of the public in Ireland. You are given a JSON evidence pack gathered
for their site plus their stated intention.

Rules:
- Ground every statement in the evidence pack. Never invent designations,
  precedents or statistics. If a section was unavailable, you may note it was
  not checked.
- You are NOT predicting a decision and NOT giving professional advice. Never
  state or imply a likelihood of permission.
- Structure: **Overview** (2-3 sentences: the headline of what this research
  found for this site and intent — a person should get the gist from this
  alone), **Site constraints** (what the designations mean for this intent),
  **What nearby decisions show** (themes from precedents and their documents,
  cited by planning reference), **Likely condition themes**, **Worth checking
  before applying** (exempt-development thresholds, a pre-planning meeting with
  the council, and the specific chapters of the local development plan named in
  the evidence pack that bear on this proposal).
- Plain English, no legalese. 350-550 words. Markdown with the five bold
  headings above only.`;

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

  track("designations", deps.getDesignations(input.lat, input.lng), "designation services did not respond");
  track("heritage_points", deps.getHeritagePoints(input.lat, input.lng), "heritage services did not respond");
  track("flood_ground", deps.getFloodGround(input.lat, input.lng), "flood and ground services did not respond");
  track(
    "precedents",
    rowsPromise.then((rows) => {
      if (!rows) throw new Error("rows unavailable");
      return { items: selectPrecedents(rows.nearby, input.lat, input.lng, input.intent), deep_dives: [] as DeepDive[] };
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

  // Deep-dive the documents behind the strongest decided/appealed precedents.
  const precedents = sections.precedents as { items?: ScoredPrecedent[]; deep_dives?: DeepDive[] } | undefined;
  if (Array.isArray(precedents?.items) && precedents.items.length) {
    const dives: DeepDive[] = [];
    for (const cand of deepDiveCandidates(precedents.items)) {
      yield { type: "progress", step: `Reading the decision documents for ${cand.planning_reference}…` };
      try {
        const read = await deps.readPrecedentDocument(cand, DEEP_DIVE_QUESTION);
        if (read) {
          dives.push({
            planning_reference: cand.planning_reference,
            authority_id: cand.authority_id,
            document: read.document,
            extract: read.answer,
          });
        }
      } catch {
        // One unreadable document never sinks the report.
      }
    }
    precedents.deep_dives = dives;
    sections.precedents = precedents;
    yield { type: "section", name: "precedents", data: precedents };
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
