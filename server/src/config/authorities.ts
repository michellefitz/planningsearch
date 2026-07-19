/**
 * The five v1 authorities, their source systems, and best-effort deep-link
 * builders into each council's own portal.
 *
 * Deep-link patterns are the Phase 0 spike surface (PRD §5.2/§9): the national
 * dataset carries a per-application `LinkAppDetails` URL which we always prefer
 * when present; these builders are the fallback when it is missing or stale.
 */

export type SourceSystem = "agile" | "swiftlg" | "localgov" | "eplanning";

export interface AuthorityConfig {
  id: string;
  name: string;
  shortName: string;
  sourceSystem: SourceSystem;
  portalBaseUrl: string;
  /** Path slug on planning.agileapplications.ie for Agile-hosted councils. */
  agileSlug?: string;
  gisUrl: string | null;
  /** Values used for this authority in the national dataset's PlanningAuthority field. */
  nationalDbNames: string[];
  /**
   * Case-insensitive substring (SQL LIKE fragment) that uniquely identifies
   * this authority in PlanningAuthority — used both for the ArcGIS WHERE
   * clause and for tolerant name matching (accents/hyphens vary at source,
   * e.g. "Dun Laoghaire Rathdown" vs "Dún Laoghaire-Rathdown").
   */
  nationalDbLike: string;
  /** Best-effort link to the application (or a pre-filled search) on the official portal. */
  portalUrlForReference: (reference: string) => string;
  /** Rough bounding box [west, south, east, north] used for sanity-checking ingested geometry. */
  bbox: [number, number, number, number];
}

export const AUTHORITIES: AuthorityConfig[] = [
  {
    id: "dublin-city",
    name: "Dublin City Council",
    shortName: "Dublin City",
    sourceSystem: "agile",
    portalBaseUrl: "https://planning.agileapplications.ie/dublincity",
    agileSlug: "dublincity",
    gisUrl: "https://mapzone.dublincity.ie",
    nationalDbNames: ["Dublin City Council", "Dublin City"],
    nationalDbLike: "Dublin City",
    portalUrlForReference: (ref) =>
      // Agile's stable per-application URL needs its internal id (resolved at
      // click time by /api/applications/:id/portal); the floor is the search
      // page with the reference pre-filled.
      `https://planning.agileapplications.ie/dublincity/search-applications/?keyword=${encodeURIComponent(ref)}`,
    bbox: [-6.387, 53.298, -6.11, 53.411],
  },
  {
    id: "fingal",
    name: "Fingal County Council",
    shortName: "Fingal",
    sourceSystem: "agile",
    portalBaseUrl: "https://planning.agileapplications.ie/fingal",
    agileSlug: "fingal",
    gisUrl: null,
    nationalDbNames: ["Fingal County Council", "Fingal"],
    nationalDbLike: "Fingal",
    portalUrlForReference: (ref) =>
      `https://planning.agileapplications.ie/fingal/search-applications/?keyword=${encodeURIComponent(ref)}`,
    bbox: [-6.5, 53.35, -6.05, 53.64],
  },
  {
    id: "dlr",
    name: "Dún Laoghaire-Rathdown County Council",
    shortName: "Dún Laoghaire-Rathdown",
    sourceSystem: "swiftlg",
    portalBaseUrl: "https://planning.dlrcoco.ie/swiftlg",
    gisUrl: null,
    nationalDbNames: [
      "Dun Laoghaire Rathdown County Council",
      "Dún Laoghaire-Rathdown County Council",
      "Dun Laoghaire-Rathdown",
    ],
    nationalDbLike: "Laoghaire",
    portalUrlForReference: (ref) =>
      // SwiftLG's documented pattern for a direct application view.
      `https://planning.dlrcoco.ie/swiftlg/apas/run/WPHAPPDETAIL.DisplayUrl?theApnID=${encodeURIComponent(ref)}`,
    bbox: [-6.31, 53.2, -6.09, 53.32],
  },
  {
    id: "south-dublin",
    name: "South Dublin County Council",
    shortName: "South Dublin",
    // SDCC migrated its live register from planning.southdublin.ie / the
    // localgov portal to Agile Applications; the old LinkAppDetails URLs in
    // the national dataset are dead and are replaced at ingest.
    sourceSystem: "agile",
    portalBaseUrl: "https://planning.agileapplications.ie/southdublin",
    agileSlug: "southdublin",
    gisUrl: null,
    nationalDbNames: ["South Dublin County Council", "South Dublin"],
    nationalDbLike: "South Dublin",
    portalUrlForReference: (ref) =>
      `https://planning.agileapplications.ie/southdublin/search-applications/?keyword=${encodeURIComponent(ref)}`,
    bbox: [-6.55, 53.22, -6.29, 53.37],
  },
  {
    id: "kildare",
    name: "Kildare County Council",
    shortName: "Kildare",
    sourceSystem: "eplanning",
    portalBaseUrl: "https://www.eplanning.ie/KildareCC",
    gisUrl: "https://webgeo.kildarecoco.ie/planningenquiry",
    nationalDbNames: ["Kildare County Council", "Kildare"],
    nationalDbLike: "Kildare",
    portalUrlForReference: (ref) =>
      `https://www.eplanning.ie/KildareCC/searchtypes?query=${encodeURIComponent(ref)}`,
    bbox: [-7.17, 52.94, -6.45, 53.45],
  },
];

export const AUTHORITY_BY_ID = new Map(AUTHORITIES.map((a) => [a.id, a]));

/** Strip accents/punctuation for tolerant matching of source authority names. */
function normalizeName(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

export function authorityIdForNationalName(name: string): string | null {
  const needle = normalizeName(name);
  if (!needle) return null;
  // "South Dublin" must be checked before the generic "Dublin City" match
  // cannot collide, but keep ordering deterministic: most specific first.
  const ordered = [...AUTHORITIES].sort(
    (a, b) => b.nationalDbLike.length - a.nationalDbLike.length
  );
  for (const a of ordered) {
    if (needle.includes(normalizeName(a.nationalDbLike))) return a.id;
  }
  return null;
}
