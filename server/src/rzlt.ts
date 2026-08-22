/**
 * RZLT (Residential Zoned Land Tax) lookup against the national Final Map
 * layer (DHLGH, same ArcGIS org as the planning applications and zoning).
 * One point-in-polygon query per application, on demand.
 */

export const RZLT_URL =
  process.env.PLANVIEW_RZLT_URL ??
  "https://services.arcgis.com/NzlPQPKn5QF9v2US/arcgis/rest/services/Residential_Zoned_Land_Tax_Final_Map2026_view/FeatureServer/0/query";
const TIMEOUT_MS = 10_000;

export interface RzltInfo {
  parcel_id: string;
  authority: string;
  zone: string;
  zone_desc: string;
  area_ha: number | null;
  date_added: string | null;
}

export async function fetchRzlt(lat: number, lng: number): Promise<RzltInfo[] | null> {
  const params = new URLSearchParams({
    geometry: JSON.stringify({ x: lng, y: lat, spatialReference: { wkid: 4326 } }),
    geometryType: "esriGeometryPoint",
    spatialRel: "esriSpatialRelIntersects",
    where: "1=1",
    outFields: "PARCEL_ID,LOCAL_AUTHORITY_NAME,ZONE_GZT,GZT_DESC,ZONE_ORIG,SITE_AREA,DATE_ADDED",
    returnGeometry: "false",
    f: "json",
  });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${RZLT_URL}?${params}`, { signal: controller.signal });
    if (!res.ok) return null;
    const body = (await res.json()) as {
      features?: Array<{ attributes: Record<string, unknown> }>;
      error?: unknown;
    };
    if (body.error || !Array.isArray(body.features)) return null;
    return body.features.map((f) => {
      const a = f.attributes;
      const ts = typeof a.DATE_ADDED === "number" ? a.DATE_ADDED : null;
      return {
        parcel_id: String(a.PARCEL_ID ?? "").trim(),
        authority: String(a.LOCAL_AUTHORITY_NAME ?? "").trim(),
        zone: String(a.ZONE_GZT ?? "").trim(),
        zone_desc: String(a.GZT_DESC ?? a.ZONE_ORIG ?? "").trim(),
        area_ha: typeof a.SITE_AREA === "number" ? Math.round(a.SITE_AREA * 1000) / 1000 : null,
        date_added: ts ? new Date(ts).toISOString().slice(0, 10) : null,
      };
    });
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
