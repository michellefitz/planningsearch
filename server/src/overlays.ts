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
  zoning: { url: GZT_URL, where: "CURRENT_PLAN=1", outFields: "ZONE_ORIG,ZONE_DESC,GZT_DESC,PLAN_NAME" },
  flood: { url: FLOOD_URL, where: "1=1", outFields: "*" },
};

/**
 * Map a zone's description onto a generalised group for colouring. Matched on
 * keywords rather than exact category strings, since councils word their zone
 * objectives differently.
 */
export function classifyZone(text: string): string {
  const t = text.toLowerCase();
  if (/mixed/.test(t)) return "mixed";
  if (/resid|\bhousing\b|dwelling/.test(t)) return "residential";
  if (/commerc|retail|town centre|village centre|city centre|tourism/.test(t)) return "commercial";
  if (/industr|enterprise|employ|business|logistic|warehous|extract/.test(t)) return "industrial";
  if (/communit|educat|institution|civic|health|social|amenity building/.test(t)) return "community";
  if (/open space|amenity|recreat|green|park|\bsport\b|passive|active|woodland/.test(t)) return "open_space";
  if (/agricul|rural|farm/.test(t)) return "agriculture";
  if (/transport|utilit|infrastructure|\bport\b|airport|\broad\b|energy/.test(t)) return "infrastructure";
  if (/water|marine|coastal|\briver\b|lake|estuar/.test(t)) return "water";
  return "other";
}

const s = (v: unknown): string => (typeof v === "string" ? v.trim() : v == null ? "" : String(v));

const FLOOD_SCENARIO_FIELDS = [
  "Probability", "PROBABILITY", "Scenario", "SCENARIO", "AEP", "Flood_Zone", "FLOOD_ZONE",
  "FloodZone", "Flood_Type", "FLOOD_TYPE", "Type", "TYPE", "Likelihood", "Event", "Class",
  "Descriptor", "DESCRIPT", "Description", "DESCRIPTION",
];
function floodLabel(props: Record<string, unknown>): string {
  for (const f of FLOOD_SCENARIO_FIELDS) {
    const v = s(props[f]);
    if (v && v.length <= 60) return v;
  }
  return "Mapped flood extent";
}

/** Slim + enrich each feature's properties for colouring and click-popups. */
function transformFeatures(layer: OverlayLayer, features: unknown[]): unknown[] {
  return features.map((raw) => {
    const f = raw as { properties?: Record<string, unknown> };
    const p = f.properties ?? {};
    if (layer === "zoning") {
      const desc = s(p.GZT_DESC) || s(p.ZONE_DESC) || s(p.ZONE_ORIG);
      f.properties = {
        zone_group: classifyZone(desc),
        zone_label: s(p.ZONE_DESC) || s(p.ZONE_ORIG) || "Zone",
        zone_code: s(p.ZONE_ORIG),
        plan: s(p.PLAN_NAME),
      };
    } else {
      f.properties = { flood_label: floodLabel(p) };
    }
    return f;
  });
}

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
    return { type: "FeatureCollection", features: transformFeatures(layer, body.features) };
  } catch {
    return EMPTY;
  } finally {
    clearTimeout(timer);
  }
}
