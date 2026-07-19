/**
 * Land-use zoning lookup against the national Generalised Zoning Types layer
 * (MyPlan / DHLGH, same ArcGIS org as the planning applications service).
 * One point-in-polygon query per application, on demand — a location can sit
 * in more than one current plan (Development Plan + Local Area Plan).
 */

const GZT_URL =
  "https://services.arcgis.com/NzlPQPKn5QF9v2US/ArcGIS/rest/services/GZT_Current_Plan/FeatureServer/0/query";
const TIMEOUT_MS = 10_000;

export interface ZoningInfo {
  zone: string;
  general: string | null;
  objective: string | null;
  plan: string | null;
  plan_level: string | null;
  plan_url: string | null;
}

function urlOrNull(v: unknown): string | null {
  const s = String(v ?? "").trim();
  return /^https?:\/\//i.test(s) ? s : null;
}

export async function fetchZoning(lat: number, lng: number): Promise<ZoningInfo[] | null> {
  const params = new URLSearchParams({
    geometry: JSON.stringify({ x: lng, y: lat, spatialReference: { wkid: 4326 } }),
    geometryType: "esriGeometryPoint",
    spatialRel: "esriSpatialRelIntersects",
    where: "CURRENT_PLAN=1",
    // GZT_LINK is omitted: the dataset's links point at the decommissioned
    // viewer.myplan.ie host, so they no longer resolve.
    outFields: "ZONE_ORIG,ZONE_GZT,GZT_DESC,ZONE_DESC,PLAN_NAME,PLAN_LEVEL,ZONE_LINK",
    returnGeometry: "false",
    f: "json",
  });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${GZT_URL}?${params}`, { signal: controller.signal });
    if (!res.ok) return null;
    const body = (await res.json()) as {
      features?: Array<{ attributes: Record<string, unknown> }>;
      error?: unknown;
    };
    if (body.error || !Array.isArray(body.features)) return null;
    const zones = body.features
      .map((f) => f.attributes)
      .map((a) => ({
        zone: String(a.ZONE_ORIG ?? "").trim(),
        general: String(a.GZT_DESC ?? "").trim() || null,
        objective: String(a.ZONE_DESC ?? "").trim() || null,
        plan: String(a.PLAN_NAME ?? "").trim() || null,
        plan_level: String(a.PLAN_LEVEL ?? "").trim() || null,
        plan_url: urlOrNull(a.ZONE_LINK),
      }))
      .filter((z) => z.zone);
    // Development Plan zoning first, then Local Area Plans.
    zones.sort((a, b) => (a.plan_level === "DP" ? 0 : 1) - (b.plan_level === "DP" ? 0 : 1));
    const seen = new Set<string>();
    return zones.filter((z) => !seen.has(z.zone) && seen.add(z.zone));
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
