/** Types for the shared condition/reason label helpers (labels.mjs). */
export declare function isGenericTitle(title: string | null | undefined): boolean;
export declare function themesFor(text: string | null | undefined): string[];
/** True when the item is the whole decision order rather than one condition —
 *  DLR files its schedules that way. */
export declare function isDecisionSchedule(text: string | null | undefined): boolean;
/** How many conditions such a schedule holds, or null when it is not a
 *  schedule or the number cannot be read from it. */
export declare function scheduleConditionCount(text: string | null | undefined): number | null;
export declare function itemLabel(
  item: {
    title?: string | null;
    text?: string | null;
    code_label?: string | null;
    order?: number | null;
  },
  fallbackNumber?: number
): string;
