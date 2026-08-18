/** Types for the further-information summariser (further-info.mjs). */
export interface ConditionLike {
  code?: string | null;
  title?: string | null;
  text?: string | null;
  order?: number | null;
}
export declare const FURTHER_INFO_PROMPT: string;
export declare function findFurtherInfoDocIndex(
  files: Array<{ title?: string | null }> | null | undefined
): number;
export declare function furtherInfoItems<T extends ConditionLike>(items: T[] | null | undefined): T[];
export declare function furtherInfoUserMsg(items: ConditionLike[]): string;
export declare function furtherInfoSummary(
  items: ConditionLike[] | null | undefined,
  callClaude: (system: string, content: string, maxTokens?: number, timeoutMs?: number) => Promise<string | null>
): Promise<string | null>;
