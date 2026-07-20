/**
 * Map overlays: polygon layers (zoning, flood) fetched from ArcGIS as GeoJSON
 * for the current map viewport. Proxied through us so the browser needs no
 * cross-origin access, and so we can bbox-limit, simplify and cap the payload.
 * These are the same services the per-application zoning/flood lookups use.
 */
import { GZT_URL } from "./zoning.js";
import { FLOOD_URL } from "./flood.js";

const TIMEOUT_MS = 12_000;

export type OverlayLayer = "zoning" | "flood";

interface OverlayConfig {
  url: string;
  where: string;
  outFields: string;
}

const OVERLAYS: Record<OverlayLayer, OverlayConfig> = {
  zoning: { url: GZT_URL, where: "CURRENT_PLAN=1", outFields: "ZONE_ORIG,ZONE_DESC,PLAN_NAME" },
  flood: { url: FLOOD_URL, where: "1=1", outFields: "*" },
};

const EMPTY: GeoJson = { type: "FeatureCollection", features: [] };

export interface GeoJson {
  type: "FeatureCollection";
  features: unknown[];
}

export function isOverlayLayer(v: string): v is OverlayLayer {
  return v === "zoning" || v === "flood";
}

/**
 * GeoJSON for one overlay within a bbox. Geometry is simplified to roughly one
 * screen pixel (maxAllowableOffset) and capped, so a town-level viewport stays
 * light. Always resolves — an empty collection on any error.
 */
export async function fetchOverlay(
  layer: OverlayLayer,
  bbox: [number, number, number, number]
): Promise<GeoJson> {
  const cfg = OVERLAYS[layer];
  const [w, s, e, n] = bbox;
  // ~1px of simplification tolerance for a ~1000px-wide viewport.
  const offset = Math.max((e - w) / 1000, 0);
  const params = new URLSearchParams({
    geometry: `${w},${s},${e},${n}`,
    geometryType: "esriGeometryEnvelope",
    inSR: "4326",
    outSR: "4326",
    spatialRel: "esriSpatialRelIntersects",
    where: cfg.where,
    outFields: cfg.outFields,
    returnGeometry: "true",
    geometryPrecision: "5",
    maxAllowableOffset: String(offset),
    resultRecordCount: "2000",
    f: "geojson",
  });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${cfg.url}?${params}`, { signal: controller.signal });
    if (!res.ok) return EMPTY;
    const body = (await res.json()) as GeoJson & { error?: unknown };
    if (body.error || body.type !== "FeatureCollection" || !Array.isArray(body.features)) {
      return EMPTY;
    }
    return { type: "FeatureCollection", features: body.features };
  } catch {
    return EMPTY;
  } finally {
    clearTimeout(timer);
  }
}
