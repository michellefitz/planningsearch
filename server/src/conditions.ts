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
