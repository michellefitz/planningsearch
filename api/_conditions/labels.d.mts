/** Types for the shared condition/reason label helpers (labels.mjs). */
export declare function isGenericTitle(title: string | null | undefined): boolean;
export declare function themesFor(text: string | null | undefined): string[];
export declare function itemLabel(
  item: {
    title?: string | null;
    text?: string | null;
    code_label?: string | null;
    order?: number | null;
  },
  fallbackNumber?: number
): string;
