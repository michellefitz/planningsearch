/**
 * Whether two applications sit on the same site, read from their site
 * boundaries rather than their centroids.
 *
 * distance.mjs caps the same-address list at 250 m because in a townland every
 * property normalises to one address key. That cap works on the centroid, and
 * the centroid is the weakest thing we hold: where a council geocodes to the
 * townland itself, every application in it carries the same point, and distance
 * has nothing to say about them.
 *
 * The register also gives us the site outline — the red-line boundary from the
 * national sites layer — for essentially every application in those groups
 * (128 of 128 sampled). Two applications on one site have outlines that
 * interleave; two properties in one townland have outlines with open ground
 * between them. That is a fact about the land, not about how the council typed
 * the address.
 *
 * The rule is separation, not overlap. Sampled across eight councils, the two
 * are not the same question:
 *
 *   26/2053 and 26/2054, North Cork Community Special School — an ESB
 *   substation and a staff car park extension on one campus. Their footprints
 *   overlap by only 16%, and an overlap threshold would have split them.
 *
 *   26/1952 and 26/1953, Liskillea — two different new dwelling houses whose
 *   outlines interleave completely, 35 m apart.
 *
 * What separates the school from the two houses is that the school's two works
 * packages sit on one continuous piece of ground. So we ask how much clear
 * ground lies between the outlines, and 20 m of it means two sites. Below that
 * is digitising noise: a boundary drawn to the kerb in one application and to
 * the wall in the next.
 *
 * Against the 250 m cap over 173 pairs that had a boundary on both sides:
 *
 *   agrees with the cap                                160  (92%)
 *   cap kept them, the footprints are separated         11
 *   cap dropped them, the footprints adjoin              2
 *
 * The 11 are the residue the cap cannot reach — two new dwellings 35 m apart in
 * the same townland, a bungalow and a studio 50 m apart, three separate
 * properties in Townparks. The 2 are large rural holdings whose centroids fall
 * just beyond 250 m while their outlines nearly touch, which is the case a
 * fixed radius was always going to get wrong: sampled site diagonals run to
 * 721 m, so a big enough site outgrows any radius.
 *
 * Where either application has no boundary we fall back to the centroid cap.
 * A missing outline is not evidence of anything.
 */
import { nearEnoughToRelate } from "./distance.mjs";

/** Clear ground between two site outlines, in metres, before they are read as
 *  separate sites. */
export const SITE_GAP_M = 20;

const M_PER_DEG_LAT = 110540;
const M_PER_DEG_LNG = 111320;

/**
 * The extent of a GeoJSON Polygon or MultiPolygon as [west, south, east, north].
 *
 * An extent rather than the outline itself: the question is whether two sites
 * are separated by open ground, and at the scale that separates a campus from
 * the field beside it the outlines are simple plot shapes whose extents answer
 * it. Clipping the real geometry would buy precision nothing in the sample
 * needed.
 */
export function boundsOf(geometry) {
  const coords = geometry?.coordinates;
  if (!coords) return null;
  let w = Infinity;
  let s = Infinity;
  let e = -Infinity;
  let n = -Infinity;
  const walk = (c) => {
    if (typeof c[0] === "number") {
      if (!Number.isFinite(c[0]) || !Number.isFinite(c[1])) return;
      if (c[0] < w) w = c[0];
      if (c[0] > e) e = c[0];
      if (c[1] < s) s = c[1];
      if (c[1] > n) n = c[1];
      return;
    }
    for (const part of c) walk(part);
  };
  walk(coords);
  return w === Infinity ? null : [w, s, e, n];
}

/**
 * Metres of clear ground between two extents; 0 when they touch or interleave.
 *
 * Taken as the larger of the two axis gaps, which understates the true
 * separation when the sites are offset diagonally — the honest direction to
 * err, since it keeps a pair we are less sure about.
 */
export function footprintGapM(a, b) {
  if (!a || !b) return null;
  const dLng = Math.max(0, Math.max(a[0], b[0]) - Math.min(a[2], b[2]));
  const dLat = Math.max(0, Math.max(a[1], b[1]) - Math.min(a[3], b[3]));
  const midLat = (a[1] + a[3] + b[1] + b[3]) / 4;
  return Math.max(
    dLng * M_PER_DEG_LNG * Math.cos((midLat * Math.PI) / 180),
    dLat * M_PER_DEG_LAT
  );
}

/**
 * Do these two applications share a site?
 *
 * `boundsFor` takes an application and returns its extent, or null — the
 * caller owns where boundaries come from, so this stays testable without the
 * 19 MB of geometry the register ships.
 */
export function sameSite(app, other, boundsFor) {
  const a = boundsFor?.(app) ?? null;
  const b = boundsFor?.(other) ?? null;
  if (!a || !b) return nearEnoughToRelate(app, other);
  return footprintGapM(a, b) <= SITE_GAP_M;
}
