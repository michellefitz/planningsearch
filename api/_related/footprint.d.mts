/** Types for the site-footprint helpers (footprint.mjs). */

/** A site extent as [west, south, east, north] in degrees. */
export type SiteBounds = [number, number, number, number];

/** Clear ground between two site outlines, in metres, before they are read as
 *  separate sites. */
export declare const SITE_GAP_M: number;

/** The extent of a GeoJSON Polygon or MultiPolygon, or null when it holds no
 *  usable coordinates. */
export declare function boundsOf(geometry: unknown): SiteBounds | null;

/** Metres of clear ground between two extents; 0 when they touch or
 *  interleave, null when either extent is missing. */
export declare function footprintGapM(
  a: SiteBounds | null | undefined,
  b: SiteBounds | null | undefined
): number | null;

/** Whether two applications share a site. Uses their outlines when both have
 *  one, and falls back to the centroid cap in distance.mjs when either does
 *  not. */
export declare function sameSite<T>(
  app: T,
  other: T,
  boundsFor: ((a: T) => SiteBounds | null) | null | undefined
): boolean;
