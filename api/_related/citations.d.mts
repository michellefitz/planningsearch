/** Types for the citation helpers (citations.mjs). */

export type Citation = {
  /** The reference exactly as the description wrote it. */
  reference: string;
  kind: "application" | "appeal";
};

/** References named in an application's own text, excluding its own. */
export declare function extractCitations(
  text: string | null | undefined,
  authorityId: string,
  ownReference?: string | null
): Citation[];

/** Normalised form used to match a cited reference against the register. */
export declare function referenceKey(reference: string | null | undefined): string;

/** The council register's page for a reference we do not hold, or null. */
export declare function citationPortalUrl(
  authority:
    | {
        portal_base_url?: string | null;
        source_system?: string | null;
        portalBaseUrl?: string | null;
        sourceSystem?: string | null;
      }
    | undefined
    | null,
  reference: string | null | undefined
): string | null;
