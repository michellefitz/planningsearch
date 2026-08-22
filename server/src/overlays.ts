/**
 * Map overlays: polygon layers (zoning, conservation, archaeology)
 * fetched from ArcGIS as GeoJSON for the current map viewport. Proxied
 * through us so the browser needs no cross-origin access, and so we can
 * bbox-limit, simplify and cap the payload.
 */
import { GZT_URL } from "./zoning.js";
import { RZLT_URL } from "./rzlt.js";

const TIMEOUT_MS = 12_000;

// NPWS designated areas, DHLGH's hosted service. The npws.ie webservices
// host is dead; this ArcGIS Online mirror is the live public endpoint
// (CC-BY, via data.gov.ie). Sub-layers: 0=SPA, 1=pNHA, 2=NHA, 3=SAC.
export const NPWS_URL =
  process.env.PLANVIEW_NPWS_URL ??
  "https://services-eu1.arcgis.com/Jhij7i46ouO8Cc0N/arcgis/rest/services/NPWSDesignatedAreas/FeatureServer";
export const SAC_URL = process.env.PLANVIEW_SAC_URL ?? `${NPWS_URL}/3/query`;

// The "conservation" overlay merges the four statutory nature designations,
// each feature tagged with which one it is.
const NPWS_SOURCES: Array<{ url: string; designation: string }> = [
  { url: SAC_URL, designation: "Special Area of Conservation" },
  { url: `${NPWS_URL}/0/query`, designation: "Special Protection Area" },
  { url: `${NPWS_URL}/2/query`, designation: "Natural Heritage Area" },
  { url: `${NPWS_URL}/1/query`, designation: "Proposed Natural Heritage Area" },
];

// National Monuments Service: Zones of Archaeological Notification (RMP) —
// works within one trigger a statutory NMS notification (s.12, NM Act 1930).
export const SMR_ZONE_URL =
  process.env.PLANVIEW_SMR_ZONE_URL ??
  "https://services-eu1.arcgis.com/HyjXgkV6KGMSF3jt/arcgis/rest/services/SMRZoneOpenData/FeatureServer/0/query";

export type OverlayLayer = "zoning" | "conservation" | "archaeology" | "rzlt";

interface OverlayConfig {
  url: string;
  where: string;
  outFields: string;
}

const OVERLAYS: Record<Exclude<OverlayLayer, "conservation">, OverlayConfig> = {
  zoning: { url: GZT_URL, where: "CURRENT_PLAN=1", outFields: "ZONE_ORIG,ZONE_DESC,GZT_DESC,PLAN_NAME" },
  archaeology: { url: SMR_ZONE_URL, where: "1=1", outFields: "ZONE_ID" },
  rzlt: { url: RZLT_URL, where: "1=1", outFields: "PARCEL_ID,LOCAL_AUTHORITY_NAME,ZONE_GZT,GZT_DESC,ZONE_ORIG,SITE_AREA" },
};
const CONSERVATION_FIELDS = "SITECODE,SITE_NAME,URL";

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

/** Slim + enrich each feature's properties for colouring and click-popups. */
function transformFeatures(layer: OverlayLayer, features: unknown[], designation?: string): unknown[] {
  return features.map((raw) => {
    const f = raw as { properties?: Record<string, unknown> };
    const p = f.properties ?? {};
    if (layer === "zoning") {
      const desc = s(p.GZT_DESC) || s(p.ZONE_DESC) || s(p.ZONE_ORIG);
      f.properties = {
        zone_group: classifyZone(desc),
        // Council's zone name/objective (e.g. "Sustainable Residential
        // Neighbourhoods"), its code (e.g. "Z1"), and the national
        // generalised type (e.g. "Existing Residential").
        zone_label: s(p.ZONE_DESC) || s(p.ZONE_ORIG) || "Zone",
        zone_code: s(p.ZONE_ORIG),
        zone_general: s(p.GZT_DESC),
        plan: s(p.PLAN_NAME),
      };
    } else if (layer === "conservation") {
      f.properties = {
        site_name: s(p.SITE_NAME) || designation || "Designated site",
        site_code: s(p.SITECODE),
        site_url: s(p.URL),
        designation: designation ?? "",
      };
    } else if (layer === "archaeology") {
      f.properties = { zone_ref: s(p.ZONE_ID) };
    } else if (layer === "rzlt") {
      f.properties = {
        parcel_id: s(p.PARCEL_ID),
        authority: s(p.LOCAL_AUTHORITY_NAME),
        zone: s(p.ZONE_GZT),
        zone_desc: s(p.GZT_DESC) || s(p.ZONE_ORIG),
        area_ha: typeof p.SITE_AREA === "number" ? Math.round((p.SITE_AREA as number) * 1000) / 1000 : null,
      };
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
  return v === "zoning" || v === "conservation" || v === "archaeology" || v === "rzlt";
}

/** Raw features for one ArcGIS layer within a bbox; [] on any error. */
async function queryArcGis(
  cfg: OverlayConfig,
  bbox: [number, number, number, number]
): Promise<unknown[]> {
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
    if (!res.ok) return [];
    const body = (await res.json()) as GeoJson & { error?: unknown };
    if (body.error || body.type !== "FeatureCollection" || !Array.isArray(body.features)) {
      return [];
    }
    return body.features;
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
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
  if (layer === "conservation") {
    const batches = await Promise.all(
      NPWS_SOURCES.map((src) =>
        queryArcGis({ url: src.url, where: "1=1", outFields: CONSERVATION_FIELDS }, bbox)
      )
    );
    const features = batches.flatMap((feats, i) =>
      transformFeatures(layer, feats, NPWS_SOURCES[i].designation)
    );
    return { type: "FeatureCollection", features };
  }
  const features = await queryArcGis(OVERLAYS[layer], bbox);
  return { type: "FeatureCollection", features: transformFeatures(layer, features) };
}
