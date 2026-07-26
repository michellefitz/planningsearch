/**
 * Pre-planner point data: everything the map's overlay sources can say about
 * one coordinate — designations at the point, heritage records nearby, and
 * best-effort flood/ground checks. Every fetcher is injected so tests run
 * without the network, and every section degrades to `{ unavailable }`
 * rather than failing the report.
 */
import { NPWS_URL, SAC_URL, SMR_ZONE_URL } from "../overlays.js";
import { GZT_URL } from "../zoning.js";
import { haversineMeters, pointInFeature, type GeoFeature } from "./geo.js";

export const GSI_GWV_URL =
  process.env.PLANVIEW_GSI_GWV_URL ??
  "https://gsi.geodata.gov.ie/server/rest/services/Groundwater/IE_GSI_Groundwater_Vulnerability_40K_IE26_ITM/FeatureServer/0/query";
export const NIAH_URL =
  process.env.PLANVIEW_NIAH_URL ??
  "https://services-eu1.arcgis.com/HyjXgkV6KGMSF3jt/arcgis/rest/services/NIAHBuildingsOpenData/FeatureServer/0/query";
export const SMR_POINT_URL =
  process.env.PLANVIEW_SMR_POINT_URL ??
  "https://services-eu1.arcgis.com/HyjXgkV6KGMSF3jt/arcgis/rest/services/SMROpenData/FeatureServer/0/query";

export interface StaticGeojson {
  type: string;
  features: GeoFeature[];
}

export interface PointDeps {
  /** GET a URL, parse JSON. Reject on HTTP/network failure. */
  fetchJson(url: string): Promise<unknown>;
  /** Load a baked geojson file (aca, flood). */
  loadStaticGeojson(name: "aca" | "flood"): Promise<StaticGeojson>;
}

export interface Unavailable {
  unavailable: true;
  reason: string;
}

export interface DesignationHit {
  kind: string;
  name: string;
  detail: string;
  meaning: string;
}

export interface DesignationsSection {
  items: DesignationHit[];
  checked: string[];
  failed: string[];
}

export interface HeritageItem {
  ref: string;
  name: string;
  distance_m: number | null;
  detail: string;
  url?: string;
}

export interface HeritageSection {
  niah: HeritageItem[] | Unavailable;
  smr: HeritageItem[] | Unavailable;
}

export interface FloodGroundSection {
  flood: { at_risk: boolean; scenarios: string[] } | Unavailable;
  groundwater: { category: string; description: string; meaning: string } | null | Unavailable;
  radon: Unavailable;
}

/** One plain-English line per designation kind — what it means for an application. */
export const DESIGNATION_MEANING: Record<string, string> = {
  zoning:
    "Your proposal must be a use that is permitted, or open for consideration, under this zoning objective.",
  "Special Area of Conservation":
    "EU-protected habitat. An application near or affecting it may need Appropriate Assessment screening.",
  "Special Protection Area":
    "EU-protected bird habitat. An application near or affecting it may need Appropriate Assessment screening.",
  "Natural Heritage Area":
    "Nationally protected habitat — works affecting it need extra scrutiny and may need ecological input.",
  "Proposed Natural Heritage Area":
    "Proposed for national protection; councils treat it as a material consideration.",
  archaeology:
    "Zone of Archaeological Notification — works here must be notified to the National Monuments Service, and an archaeological assessment may be required.",
  aca: "Architectural Conservation Area — external works that would normally be exempt development usually need permission here, and design standards are higher.",
  flood:
    "Indicative flood extent — a Site-Specific Flood Risk Assessment may be required, and some uses are restricted under the Flood Risk Management Guidelines.",
  groundwater_high:
    "High groundwater vulnerability — matters for wastewater treatment (septic tanks) and some ground works.",
};

const enc = (v: unknown) => encodeURIComponent(JSON.stringify(v));

function pointQueryUrl(base: string, lat: number, lng: number, outFields: string, extra: Record<string, string> = {}): string {
  const params = new URLSearchParams({
    f: "geojson",
    geometryType: "esriGeometryPoint",
    inSR: "4326",
    outSR: "4326",
    spatialRel: "esriSpatialRelIntersects",
    where: "1=1",
    outFields,
    returnGeometry: extra.returnGeometry ?? "false",
    resultRecordCount: "25",
    ...extra,
  });
  // geometry must not be re-encoded by URLSearchParams' + rules for JSON.
  return `${base}?${params}&geometry=${enc({ x: lng, y: lat, spatialReference: { wkid: 4326 } })}`;
}

const str = (v: unknown): string => (typeof v === "string" ? v.trim() : v == null ? "" : String(v));

interface GeoResult {
  features?: Array<{ properties?: Record<string, unknown>; geometry?: { type?: string; coordinates?: unknown } }>;
  error?: unknown;
}

async function features(deps: PointDeps, url: string) {
  const body = (await deps.fetchJson(url)) as GeoResult;
  if (body?.error || !Array.isArray(body?.features)) throw new Error("bad ArcGIS response");
  return body.features;
}

export async function getDesignations(lat: number, lng: number, deps: PointDeps): Promise<DesignationsSection> {
  const items: DesignationHit[] = [];
  const checked: string[] = [];
  const failed: string[] = [];

  const sources: Array<{ label: string; run(): Promise<DesignationHit[]> }> = [
    {
      label: "zoning",
      async run() {
        const feats = await features(
          deps,
          pointQueryUrl(GZT_URL, lat, lng, "ZONE_ORIG,ZONE_DESC,GZT_DESC,PLAN_NAME", { where: "CURRENT_PLAN=1" })
        );
        return feats.slice(0, 1).map((f) => {
          const p = f.properties ?? {};
          const label = str(p.ZONE_DESC) || str(p.ZONE_ORIG) || "Zoned land";
          return {
            kind: "Zoning",
            name: label,
            detail: [str(p.ZONE_ORIG), str(p.GZT_DESC), str(p.PLAN_NAME)].filter(Boolean).join(" · "),
            meaning: DESIGNATION_MEANING.zoning,
          };
        });
      },
    },
    ...[
      { url: SAC_URL, designation: "Special Area of Conservation" },
      { url: `${NPWS_URL}/0/query`, designation: "Special Protection Area" },
      { url: `${NPWS_URL}/2/query`, designation: "Natural Heritage Area" },
      { url: `${NPWS_URL}/1/query`, designation: "Proposed Natural Heritage Area" },
    ].map((src) => ({
      label: src.designation,
      async run() {
        const feats = await features(deps, pointQueryUrl(src.url, lat, lng, "SITECODE,SITE_NAME,URL"));
        return feats.map((f) => {
          const p = f.properties ?? {};
          return {
            kind: src.designation,
            name: str(p.SITE_NAME) || src.designation,
            detail: str(p.SITECODE),
            meaning: DESIGNATION_MEANING[src.designation],
          };
        });
      },
    })),
    {
      label: "archaeology",
      async run() {
        const feats = await features(deps, pointQueryUrl(SMR_ZONE_URL, lat, lng, "ZONE_ID"));
        return feats.map((f) => ({
          kind: "Zone of Archaeological Notification",
          name: `Zone ${str(f.properties?.ZONE_ID) || "(recorded monuments)"}`,
          detail: "",
          meaning: DESIGNATION_MEANING.archaeology,
        }));
      },
    },
    {
      label: "aca",
      async run() {
        const fc = await deps.loadStaticGeojson("aca");
        return fc.features
          .filter((f) => pointInFeature(lng, lat, f))
          .map((f) => {
            const p = f.properties ?? {};
            return {
              kind: "Architectural Conservation Area",
              name: str(p.aca_name) || "ACA",
              detail: [str(p.ref), str(p.council_label)].filter(Boolean).join(" · "),
              meaning: DESIGNATION_MEANING.aca,
            };
          });
      },
    },
  ];

  const results = await Promise.allSettled(sources.map((s) => s.run()));
  results.forEach((r, i) => {
    if (r.status === "fulfilled") {
      checked.push(sources[i].label);
      items.push(...r.value);
    } else {
      failed.push(sources[i].label);
    }
  });
  return { items, checked, failed };
}

const HERITAGE_RADIUS_M = 250;

function itemDistance(lat: number, lng: number, f: { geometry?: { type?: string; coordinates?: unknown } }): number | null {
  const g = f.geometry;
  if (g?.type !== "Point" || !Array.isArray(g.coordinates)) return null;
  const [x, y] = g.coordinates as [number, number];
  return Math.round(haversineMeters(lat, lng, y, x));
}

export async function getHeritagePoints(lat: number, lng: number, deps: PointDeps): Promise<HeritageSection> {
  const radius = { distance: String(HERITAGE_RADIUS_M), units: "esriSRUnit_Meter", returnGeometry: "true" };
  const [niah, smr] = await Promise.allSettled([
    features(deps, pointQueryUrl(NIAH_URL, lat, lng, "*", radius)),
    features(deps, pointQueryUrl(SMR_POINT_URL, lat, lng, "*", radius)),
  ]);
  const sort = (xs: HeritageItem[]) =>
    xs.sort((a, b) => (a.distance_m ?? 9e9) - (b.distance_m ?? 9e9)).slice(0, 12);
  return {
    niah:
      niah.status === "fulfilled"
        ? sort(
            niah.value.map((f) => {
              const p = f.properties ?? {};
              return {
                ref: str(p.REG_NO),
                name: str(p.NAME) || [str(p.NUMBER), str(p.STREET1)].filter(Boolean).join(" ") || "NIAH building",
                distance_m: itemDistance(lat, lng, f),
                detail: [str(p.ORIGINAL_TYPE), str(p.IN_USE_AS_TYPE) && `now ${str(p.IN_USE_AS_TYPE)}`]
                  .filter(Boolean)
                  .join(", "),
                url: str(p.REG_NO) ? `https://www.buildingsofireland.ie/buildings-search/building/${str(p.REG_NO)}` : undefined,
              };
            })
          )
        : { unavailable: true, reason: "NIAH service did not respond" },
    smr:
      smr.status === "fulfilled"
        ? sort(
            smr.value.map((f) => {
              const p = f.properties ?? {};
              return {
                ref: str(p.SMRS) || str(p.ENTITY_ID),
                name: str(p.CLASSDESC) || str(p.CLASS_CODE) || "Recorded monument",
                distance_m: itemDistance(lat, lng, f),
                detail: str(p.TOWNLAND),
                url: str(p.WEBSITE_LINK) || undefined,
              };
            })
          )
        : { unavailable: true, reason: "SMR service did not respond" },
  };
}

export async function getFloodGround(lat: number, lng: number, deps: PointDeps): Promise<FloodGroundSection> {
  const [flood, gwv] = await Promise.allSettled([
    deps.loadStaticGeojson("flood").then((fc) => {
      const hits = fc.features.filter((f) => pointInFeature(lng, lat, f));
      const scenarios = [...new Set(hits.map((f) => str(f.properties?.scenario)).filter(Boolean))];
      return { at_risk: hits.length > 0, scenarios };
    }),
    features(deps, pointQueryUrl(GSI_GWV_URL, lat, lng, "VUL_CAT,VUL_DESC", { f: "json" })).then((feats) => {
      // f=json shape: attributes live under `attributes`, not `properties`.
      const first = feats[0] as { attributes?: Record<string, unknown>; properties?: Record<string, unknown> } | undefined;
      const attrs = first?.attributes ?? first?.properties;
      if (!attrs) return null;
      const cat = str(attrs.VUL_CAT);
      const desc = str(attrs.VUL_DESC);
      return {
        category: cat,
        description: desc,
        meaning: /^(E|X|H)$/i.test(cat) ? DESIGNATION_MEANING.groundwater_high : "",
      };
    }),
  ]);
  return {
    flood:
      flood.status === "fulfilled"
        ? flood.value
        : { unavailable: true, reason: "flood extents could not be checked" },
    groundwater:
      gwv.status === "fulfilled"
        ? gwv.value
        : { unavailable: true, reason: "GSI groundwater service did not respond" },
    // The EPA radon ArcGIS host is not publicly reachable (probed 2026-07-26).
    radon: { unavailable: true, reason: "the EPA radon map service is not publicly accessible" },
  };
}
