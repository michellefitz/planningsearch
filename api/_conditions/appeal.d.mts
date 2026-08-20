/** Types for the appeal-outcome helpers (appeal.mjs). */
export type AppealOutcomeKind =
  | "granted"
  | "refused"
  | "withdrawn"
  | "dismissed"
  | "invalid"
  | "other"
  | null;

export interface AppealOutcome {
  /** null where nothing can be said honestly — see appeal.mjs on MODIFIED. */
  kind: AppealOutcomeKind;
  label: string | null;
  conditional: boolean;
}

export declare function appealOutcome(raw: string | null | undefined): AppealOutcome;
export declare function bestAppealDecision(
  caseFields: Array<{ label: string; value: string }> | null | undefined,
  registerDecision: string | null | undefined
): string | null;
export declare function contradictsOutcome(
  summary: string | null | undefined,
  outcomeKind: AppealOutcomeKind
): boolean;
