import { describe, expect, it } from "vitest";
import { haversineMeters, pointInFeature } from "../src/preplan/geo.js";
import {
  getDesignations,
  getFloodGround,
  getHeritagePoints,
  type PointDeps,
  type StaticGeojson,
} from "../src/preplan/point-data.js";

const square = (props: Record<string, unknown> = {}) => ({
  geometry: {
    type: "Polygon",
    coordinates: [
      [
        [-6.6, 53.3],
        [-6.5, 53.3],
        [-6.5, 53.4],
        [-6.6, 53.4],
        [-6.6, 53.3],
      ],
    ],
  },
  properties: props,
});

describe("geo", () => {
  it("haversine is ~0 at the same point and ~111km per degree of latitude", () => {
    expect(haversineMeters(53.38, -6.59, 53.38, -6.59)).toBeCloseTo(0);
    expect(haversineMeters(53, -6.59, 54, -6.59)).toBeGreaterThan(110_000);
    expect(haversineMeters(53, -6.59, 54, -6.59)).toBeLessThan(112_000);
  });

  it("pointInFeature handles polygons, misses, holes and multipolygons", () => {
    expect(pointInFeature(-6.55, 53.35, square())).toBe(true);
    expect(pointInFeature(-6.7, 53.35, square())).toBe(false);
    const withHole = {
      geometry: {
        type: "Polygon",
        coordinates: [
          square().geometry.coordinates[0],
          [
            [-6.57, 53.34],
            [-6.53, 53.34],
            [-6.53, 53.36],
            [-6.57, 53.36],
            [-6.57, 53.34],
          ],
        ],
      },
    };
    expect(pointInFeature(-6.55, 53.35, withHole)).toBe(false);
    const multi = {
      geometry: { type: "MultiPolygon", coordinates: [square().geometry.coordinates] },
    };
    expect(pointInFeature(-6.55, 53.35, multi)).toBe(true);
    expect(pointInFeature(-6.55, 53.35, { geometry: null })).toBe(false);
  });
});

function deps(overrides: Partial<PointDeps> = {}): PointDeps {
  return {
    fetchJson: async () => ({ features: [] }),
    loadStaticGeojson: async () => ({ type: "FeatureCollection", features: [] }) as StaticGeojson,
    ...overrides,
  };
}

describe("getDesignations", () => {
  it("collects hits per source and records failures without throwing", async () => {
    const d = deps({
      fetchJson: async (url: string) => {
        if (url.includes("Gazetteer") || url.includes("CURRENT_PLAN")) {
          return {
            features: [
              { properties: { ZONE_ORIG: "Z1", ZONE_DESC: "Sustainable Residential", GZT_DESC: "Existing Residential", PLAN_NAME: "Dublin City 2022" } },
            ],
          };
        }
        if (url.includes("NPWSDesignatedAreas/FeatureServer/3")) {
          return { features: [{ properties: { SITE_NAME: "Rye Water Valley", SITECODE: "001398" } }] };
        }
        if (url.includes("SMRZone")) throw new Error("down");
        return { features: [] };
      },
      loadStaticGeojson: async (name) =>
        name === "aca"
          ? ({ type: "FeatureCollection", features: [square({ aca_name: "Capel Street", ref: "AA01", council_label: "Dublin City Council" })] } as StaticGeojson)
          : ({ type: "FeatureCollection", features: [] } as StaticGeojson),
    });
    const out = await getDesignations(53.35, -6.55, d);
    const kinds = out.items.map((i) => i.kind);
    expect(kinds).toContain("Zoning");
    expect(kinds).toContain("Special Area of Conservation");
    expect(kinds).toContain("Architectural Conservation Area");
    expect(out.failed).toContain("archaeology");
    const zoning = out.items.find((i) => i.kind === "Zoning");
    expect(zoning?.name).toBe("Sustainable Residential");
    expect(zoning?.meaning).toMatch(/permitted/);
    const aca = out.items.find((i) => i.kind === "Architectural Conservation Area");
    expect(aca?.name).toBe("Capel Street");
  });
});

describe("getHeritagePoints", () => {
  it("maps NIAH/SMR attributes, sorts by distance, flags failures", async () => {
    const d = deps({
      fetchJson: async (url: string) => {
        if (url.includes("NIAH")) {
          return {
            features: [
              {
                geometry: { type: "Point", coordinates: [-6.5918, 53.383] },
                properties: { REG_NO: 11803004, NAME: "Leinster House", ORIGINAL_TYPE: "house", IN_USE_AS_TYPE: "office", STREET1: "Main Street" },
              },
              {
                geometry: { type: "Point", coordinates: [-6.5918, 53.3814] },
                properties: { REG_NO: 11803005, NAME: "Close House", ORIGINAL_TYPE: "house" },
              },
            ],
          };
        }
        throw new Error("smr down");
      },
    });
    const out = await getHeritagePoints(53.3813, -6.5918, d);
    expect(Array.isArray(out.niah)).toBe(true);
    const niah = out.niah as Array<{ ref: string; distance_m: number | null; url?: string }>;
    expect(niah[0].ref).toBe("11803005"); // nearer one first
    expect(niah[0].distance_m).toBeLessThan(30);
    expect(niah[1].url).toContain("buildingsofireland.ie");
    expect(out.smr).toMatchObject({ unavailable: true });
  });
});

describe("getFloodGround", () => {
  it("flood point-in-poly hit with scenarios; groundwater parses esri attributes", async () => {
    const d = deps({
      loadStaticGeojson: async (name) =>
        name === "flood"
          ? ({ type: "FeatureCollection", features: [square({ scenario: "Fluvial — 1% AEP" })] } as StaticGeojson)
          : ({ type: "FeatureCollection", features: [] } as StaticGeojson),
      fetchJson: async () => ({ features: [{ attributes: { VUL_CAT: "H", VUL_DESC: "High" } }] }),
    });
    const out = await getFloodGround(53.35, -6.55, d);
    expect(out.flood).toMatchObject({ at_risk: true, scenarios: ["Fluvial — 1% AEP"] });
    expect(out.groundwater).toMatchObject({ category: "H", description: "High" });
    expect((out.groundwater as { meaning: string }).meaning).toMatch(/vulnerability/);
    expect(out.radon).toMatchObject({ unavailable: true });
  });

  it("degrades per sub-check when a source rejects", async () => {
    const d = deps({
      loadStaticGeojson: async () => {
        throw new Error("no file");
      },
      fetchJson: async () => {
        throw new Error("gsi down");
      },
    });
    const out = await getFloodGround(53.35, -6.55, d);
    expect(out.flood).toMatchObject({ unavailable: true });
    expect(out.groundwater).toMatchObject({ unavailable: true });
  });
});
