/**
 * Polygon helpers shared by the site-boundary ingests (national DHLGH layer 1
 * and the An Coimisiún Pleanála case service).
 *
 * Both sources hand back ArcGIS rings in WGS84, and both want the same three
 * things: GeoJSON out, a true ground area, and a smaller polygon to ship.
 */

/** Signed ring area (shoelace) — ArcGIS outer rings are clockwise (negative). */
function ringWinding(ring: number[][]): number {
  let sum = 0;
  for (let i = 0; i < ring.length - 1; i++) {
    sum += ring[i][0] * ring[i + 1][1] - ring[i + 1][0] * ring[i][1];
  }
  return sum / 2;
}

/**
 * ArcGIS rings → GeoJSON MultiPolygon coordinates. ArcGIS mixes outer rings
 * (clockwise) and holes (counter-clockwise) in one flat list; each outer ring
 * starts a polygon and following holes attach to it.
 */
export function ringsToMultiPolygon(rings: number[][][]): number[][][][] | null {
  const polys: number[][][][] = [];
  for (const raw of rings) {
    if (raw.length < 4) continue;
    // 6 dp ≈ 0.1 m — full-precision doubles double the baked size for nothing.
    const ring = raw.map(([x, y]) => [Math.round(x * 1e6) / 1e6, Math.round(y * 1e6) / 1e6]);
    if (ringWinding(ring) <= 0 || polys.length === 0) polys.push([ring]);
    else polys[polys.length - 1].push(ring);
  }
  return polys.length ? polys : null;
}

// Mean Earth radius used by the spherical-excess area formula below.
const EARTH_RADIUS_M = 6378137;
const toRad = (deg: number): number => (deg * Math.PI) / 180;

/**
 * Geodesic area of a closed WGS84 ring, in square metres, by spherical excess.
 *
 * Checked against the councils' own published AreaofSite for 1,000 Dublin City
 * sites: agreement within 0.3%. That matters because it is the basis for
 * replacing that field rather than trusting it — see fetchAllSites.
 */
export function ringAreaSqm(ring: number[][]): number {
  let total = 0;
  for (let i = 0; i < ring.length - 1; i++) {
    const [lng1, lat1] = ring[i];
    const [lng2, lat2] = ring[i + 1];
    total += toRad(lng2 - lng1) * (2 + Math.sin(toRad(lat1)) + Math.sin(toRad(lat2)));
  }
  return Math.abs((total * EARTH_RADIUS_M * EARTH_RADIUS_M) / 2);
}

/** Ground area of a GeoJSON MultiPolygon in square metres, holes subtracted. */
export function multiPolygonAreaSqm(coords: number[][][][]): number {
  let total = 0;
  for (const poly of coords) {
    for (let i = 0; i < poly.length; i++) {
      const a = ringAreaSqm(poly[i]);
      total += i === 0 ? a : -a;
    }
  }
  return total > 0 ? total : 0;
}

/**
 * Local equirectangular projection to metres about a reference latitude, so
 * simplification tolerances can be expressed in metres rather than degrees
 * (a degree of longitude is ~0.6 of a degree of latitude at Irish latitudes,
 * which would otherwise simplify east-west twice as hard as north-south).
 */
function project(ring: number[][]): number[][] {
  const lat0 = toRad(ring[0][1]);
  const mPerDegLat = 111132.92;
  const mPerDegLng = 111319.49 * Math.cos(lat0);
  return ring.map(([lng, lat]) => [lng * mPerDegLng, lat * mPerDegLat]);
}

/** Squared perpendicular distance from p to segment ab, in projected units. */
function perpDistSq(p: number[], a: number[], b: number[]): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  if (dx === 0 && dy === 0) return (p[0] - a[0]) ** 2 + (p[1] - a[1]) ** 2;
  const t = ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / (dx * dx + dy * dy);
  const clamped = t < 0 ? 0 : t > 1 ? 1 : t;
  const cx = a[0] + clamped * dx;
  const cy = a[1] + clamped * dy;
  return (p[0] - cx) ** 2 + (p[1] - cy) ** 2;
}

/** Douglas-Peucker over an index range, marking which points to keep. */
function markKeepers(pts: number[][], first: number, last: number, tolSq: number, keep: boolean[]): void {
  let worst = -1;
  let worstDist = 0;
  for (let i = first + 1; i < last; i++) {
    const d = perpDistSq(pts[i], pts[first], pts[last]);
    if (d > worstDist) {
      worstDist = d;
      worst = i;
    }
  }
  if (worstDist <= tolSq || worst < 0) return;
  keep[worst] = true;
  markKeepers(pts, first, worst, tolSq, keep);
  markKeepers(pts, worst, last, tolSq, keep);
}

/**
 * Douglas-Peucker simplification of a closed ring at a tolerance in metres.
 * Returns the original ring when simplifying would degenerate it (fewer than
 * three distinct corners), so a small site is never reduced to a sliver.
 */
export function simplifyRing(ring: number[][], toleranceM: number): number[][] {
  if (ring.length <= 4) return ring;
  const pts = project(ring);
  const keep = new Array<boolean>(ring.length).fill(false);
  keep[0] = true;
  keep[ring.length - 1] = true;
  markKeepers(pts, 0, ring.length - 1, toleranceM * toleranceM, keep);
  const out = ring.filter((_, i) => keep[i]);
  return out.length >= 4 ? out : ring;
}

/** Simplify every ring of a MultiPolygon, dropping rings that degenerate. */
export function simplifyMultiPolygon(coords: number[][][][], toleranceM: number): number[][][][] | null {
  const polys: number[][][][] = [];
  for (const poly of coords) {
    const rings = poly.map((r) => simplifyRing(r, toleranceM)).filter((r) => r.length >= 4);
    if (rings.length) polys.push(rings);
  }
  return polys.length ? polys : null;
}
