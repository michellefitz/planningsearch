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
  /**
   * Names the LIKE above would also catch, excluded from the ingest WHERE.
   * SQL LIKE has no word boundaries, so "%Meath%" matches Westmeath — the
   * name resolver drops those rows, but without this the fetch drags ~5,500
   * of them across the wire on every build.
   */
  nationalDbNotLike?: string[];
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
    // DLR retired SwiftLG (planning.dlrcoco.ie now hosts an unrelated APEX
    // housing app) and moved its register to Agile Applications.
    sourceSystem: "agile",
    portalBaseUrl: "https://planning.agileapplications.ie/dunlaoghaire",
    agileSlug: "dunlaoghaire",
    gisUrl: null,
    nationalDbNames: [
      "Dun Laoghaire Rathdown County Council",
      "Dún Laoghaire-Rathdown County Council",
      "Dun Laoghaire-Rathdown",
    ],
    nationalDbLike: "Laoghaire",
    portalUrlForReference: (ref) =>
      `https://planning.agileapplications.ie/dunlaoghaire/search-applications/?keyword=${encodeURIComponent(ref)}`,
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
  // Meath and Wicklow run the same LGMA eplanning system as Kildare, on their
  // own council slugs, with iDocs document servers on their own hosts. Nothing
  // about them needed new ingest machinery — the national feed carries both at
  // 100% for description, address, status, decision and detail link, with site
  // boundaries for 100% of Meath and 98% of Wicklow.
  {
    id: "meath",
    name: "Meath County Council",
    shortName: "Meath",
    sourceSystem: "eplanning",
    portalBaseUrl: "https://www.eplanning.ie/MeathCC",
    gisUrl: "https://meathcoco.maps.arcgis.com/apps/webappviewer/index.html?id=e268775bc8dc4b40bc9e3f8878e45862",
    nationalDbNames: ["Meath County Council", "Meath"],
    nationalDbLike: "Meath",
    nationalDbNotLike: ["Westmeath"],
    portalUrlForReference: (ref) =>
      `https://www.eplanning.ie/MeathCC/searchtypes?query=${encodeURIComponent(ref)}`,
    // Measured from 2,000 sampled feed geometries, trimmed to the 99.6% range
    // so a mistyped coordinate can't widen the sanity box.
    bbox: [-7.3, 53.38, -6.21, 53.91],
  },
  {
    id: "wicklow",
    name: "Wicklow County Council",
    shortName: "Wicklow",
    sourceSystem: "eplanning",
    portalBaseUrl: "https://www.eplanning.ie/WicklowCC",
    gisUrl: "https://wicklow.maps.arcgis.com/apps/webappviewer/index.html?id=57b22c27e7c049fbac54117da1a20f60",
    nationalDbNames: ["Wicklow County Council", "Wicklow"],
    nationalDbLike: "Wicklow",
    portalUrlForReference: (ref) =>
      `https://www.eplanning.ie/WicklowCC/searchtypes?query=${encodeURIComponent(ref)}`,
    bbox: [-6.79, 52.68, -6.01, 53.23],
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
  // Whole words, not a raw substring: "Westmeath County Council" contains
  // "Meath", and matching loosely filed every Westmeath application under
  // Meath. Padding both sides makes " meath " fail to match " westmeath ",
  // while "Dun Laoghaire Rathdown" still matches on its own words.
  const padded = ` ${needle} `;
  for (const a of ordered) {
    if (padded.includes(` ${normalizeName(a.nationalDbLike)} `)) return a.id;
  }
  return null;
}
