/** Types for the decision-stage helpers (decision.mjs). */
export type DecisionStage = "further_info" | "procedural" | "placeholder" | null;
export declare function decisionStage(decision: string | null | undefined): DecisionStage;
export declare function realDecision(decision: string | null | undefined): string | null;
export declare function isFurtherInfoRequest(decision: string | null | undefined): boolean;
