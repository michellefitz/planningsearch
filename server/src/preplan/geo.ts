/** Small geometry helpers for the pre-planner point queries. */

export function haversineMeters(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

type Ring = [number, number][];
type PolygonCoords = Ring[];
type MultiPolygonCoords = PolygonCoords[];

export interface GeoFeature {
  geometry?: { type?: string; coordinates?: unknown } | null;
  properties?: Record<string, unknown> | null;
}

function inRing(lng: number, lat: number, ring: Ring): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > lat !== yj > lat && lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

// Even-odd across all rings, so holes subtract naturally.
function inPolygon(lng: number, lat: number, poly: PolygonCoords): boolean {
  let count = 0;
  for (const ring of poly) if (inRing(lng, lat, ring)) count++;
  return count % 2 === 1;
}

export function pointInFeature(lng: number, lat: number, feature: GeoFeature): boolean {
  const g = feature.geometry;
  if (!g?.type || !Array.isArray(g.coordinates)) return false;
  if (g.type === "Polygon") return inPolygon(lng, lat, g.coordinates as PolygonCoords);
  if (g.type === "MultiPolygon") {
    return (g.coordinates as MultiPolygonCoords).some((poly) => inPolygon(lng, lat, poly));
  }
  return false;
}
