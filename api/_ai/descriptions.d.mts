/** Types for the shared description-summary helpers (descriptions.mjs). */
export declare function descriptionKey(description: string | null | undefined): string | null;
export declare const DESCRIPTION_SUMMARY_PROMPT: string;
export declare function descriptionUserMsg(
  description: string,
  applicationType?: string | null
): string;
