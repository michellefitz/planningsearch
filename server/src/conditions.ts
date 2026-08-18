/**
 * Bridge to the shared condition-highlights module.
 *
 * The prompt and its validation live in `api/_conditions/highlights.mjs` so
 * the deployed API and this dev server run exactly the same one — the two
 * summarisers that were copied instead have already drifted. It is loaded at
 * runtime rather than imported, because the module sits outside this package's
 * rootDir; the relative path is the same from `src/` and from `dist/`.
 */

export interface ConditionHighlight {
  /** The condition number as shown in the UI, so a point can be traced back. */
  n: number;
  point: string;
}

type CallClaude = (
  system: string,
  content: string,
  maxTokens?: number,
  timeoutMs?: number
) => Promise<string | null>;

interface HighlightsModule {
  conditionHighlights: (
    items: Array<{ code: string; text: string; order: number }>,
    callClaude: CallClaude
  ) => Promise<ConditionHighlight[] | null>;
}

let cached: Promise<HighlightsModule> | null = null;

export function loadHighlightsModule(): Promise<HighlightsModule> {
  cached ??= import(
    new URL("../../api/_conditions/highlights.mjs", import.meta.url).href
  ) as Promise<HighlightsModule>;
  return cached;
}

interface FurtherInfoModule {
  furtherInfoItems: <T>(items: T[] | null | undefined) => T[];
  furtherInfoSummary: (
    items: Array<{ code: string; title?: string | null; text: string; order: number }>,
    callClaude: CallClaude
  ) => Promise<string | null>;
}

let cachedFurtherInfo: Promise<FurtherInfoModule> | null = null;

/** Same bridge, for the request the council makes before it decides. */
export function loadFurtherInfoModule(): Promise<FurtherInfoModule> {
  cachedFurtherInfo ??= import(
    new URL("../../api/_conditions/further-info.mjs", import.meta.url).href
  ) as Promise<FurtherInfoModule>;
  return cachedFurtherInfo;
}

interface DecisionModule {
  decisionStage: (
    decision: string | null | undefined
  ) => "further_info" | "procedural" | "placeholder" | null;
  realDecision: (decision: string | null | undefined) => string | null;
  isFurtherInfoRequest: (decision: string | null | undefined) => boolean;
}

let cachedDecision: Promise<DecisionModule> | null = null;

/** Same bridge again, for telling a decision from a progress note. The rules
 *  are mirrored in normalize.ts for ingestion; decision-stage.test.ts holds
 *  the two copies to the same answers. */
export function loadDecisionModule(): Promise<DecisionModule> {
  cachedDecision ??= import(
    new URL("../../api/_conditions/decision.mjs", import.meta.url).href
  ) as Promise<DecisionModule>;
  return cachedDecision;
}
