/** Types for the development-contribution total (contribution.mjs). */
export declare function payableAmounts(text: string | null | undefined): number[];
export declare function developmentContribution(
  items: Array<{ code?: string | null; order?: number | null; text?: string | null }> | null | undefined
): { total: number; condition: number } | null;
