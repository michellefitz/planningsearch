/**
 * Indicative flood-risk lookup at an application's location, from the OPW's
 * national flood-mapping ArcGIS service (floodinfo.ie). One point-in-polygon
 * query per application, on demand — the same shape as the zoning lookup.
 *
 * This is INDICATIVE mapping, never a site-specific flood risk assessment, so
 * the UI carries a caveat and links out to floodinfo.ie. The service URL is
 * env-overridable because the OPW publishes several layers (NIFM fluvial, NICM
 * coastal) and the canonical endpoint may change.
 */

export const FLOOD_URL =
  process.env.PLANVIEW_FLOOD_URL ??
  "https://services7.arcgis.com/aopigSLPh2SnT3cX/ArcGIS/rest/services/Flood_Maps/FeatureServer/0/query";
const TIMEOUT_MS = 10_000;

export interface FloodResult {
  /** The point falls inside at least one mapped flood extent. */
  at_risk: boolean;
  /** Human-readable labels for the extents it falls in (probability/scenario). */
  scenarios: string[];
}

export interface FloodDiagnostic {
  step: string;
  url?: string;
  status?: number;
  featureCount?: number;
  bodySnippet?: string;
  error?: string;
}

// Fields (across the OPW layers) that describe which flood extent a point is
// in — probability/AEP, fluvial vs coastal, flood-zone class, or a description.
const SCENARIO_FIELDS = [
  "Probability",
  "PROBABILITY",
  "Scenario",
  "SCENARIO",
  "AEP",
  "Flood_Zone",
  "FLOOD_ZONE",
  "FloodZone",
  "Flood_Type",
  "FLOOD_TYPE",
  "Type",
  "TYPE",
  "Likelihood",
  "Event",
  "Class",
  "Descriptor",
  "DESCRIPT",
  "Description",
  "DESCRIPTION",
];
const SCENARIO_KEY_RE = /prob|scenario|aep|zone|fluvial|coastal|likelihood|extent|event/i;

function scenarioLabel(attrs: Record<string, unknown>): string | null {
  for (const f of SCENARIO_FIELDS) {
    const v = attrs[f];
    if (typeof v === "string" && v.trim() && v.trim().length <= 60) return v.trim();
  }
  // Fall back to any short string field whose key looks scenario-ish.
  for (const [k, v] of Object.entries(attrs)) {
    if (typeof v === "string" && v.trim() && v.trim().length <= 60 && SCENARIO_KEY_RE.test(k)) {
      return v.trim();
    }
  }
  return null;
}

export async function fetchFlood(
  lat: number,
  lng: number,
  trace?: FloodDiagnostic[]
): Promise<FloodResult | null> {
  const params = new URLSearchParams({
    geometry: JSON.stringify({ x: lng, y: lat, spatialReference: { wkid: 4326 } }),
    geometryType: "esriGeometryPoint",
    inSR: "4326",
    spatialRel: "esriSpatialRelIntersects",
    where: "1=1",
    outFields: "*",
    returnGeometry: "false",
    f: "json",
  });
  const url = `${FLOOD_URL}?${params}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) {
      trace?.push({ step: "flood_query", url, status: res.status, error: "non-200" });
      return null;
    }
    const body = (await res.json()) as {
      features?: Array<{ attributes: Record<string, unknown> }>;
      error?: unknown;
    };
    if (body.error || !Array.isArray(body.features)) {
      trace?.push({ step: "flood_query", url, bodySnippet: JSON.stringify(body).slice(0, 500), error: "no-features" });
      return null;
    }
    const scenarios = Array.from(
      new Set(body.features.map((f) => scenarioLabel(f.attributes)).filter((s): s is string => !!s))
    );
    trace?.push({
      step: "flood_query",
      url,
      status: res.status,
      featureCount: body.features.length,
      bodySnippet: JSON.stringify(body.features.slice(0, 3)).slice(0, 800),
    });
    return { at_risk: body.features.length > 0, scenarios };
  } catch (err) {
    trace?.push({ step: "flood_query", url, error: err instanceof Error ? err.message : String(err) });
    return null;
  } finally {
    clearTimeout(timer);
  }
}
