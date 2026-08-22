import { describe, expect, it } from "vitest";
import {
  boundsOf,
  footprintGapM,
  sameSite,
  SITE_GAP_M,
} from "../../api/_related/footprint.mjs";
import { nearEnoughToRelate } from "../../api/_related/distance.mjs";

/** A square site of side `m` metres with its south-west corner at lng/lat. */
function site(lng: number, lat: number, m = 40) {
  const dLat = m / 110540;
  const dLng = m / (111320 * Math.cos((lat * Math.PI) / 180));
  return {
    type: "Polygon",
    coordinates: [
      [
        [lng, lat],
        [lng + dLng, lat],
        [lng + dLng, lat + dLat],
        [lng, lat + dLat],
        [lng, lat],
      ],
    ],
  };
}
/** Metres east/north of a base point, in degrees. */
const east = (lng: number, lat: number, m: number) =>
  lng + m / (111320 * Math.cos((lat * Math.PI) / 180));
const north = (lat: number, m: number) => lat + m / 110540;

describe("boundsOf", () => {
  it("reads the extent of a polygon", () => {
    const b = boundsOf(site(-6.5, 53.4))!;
    expect(b[0]).toBeCloseTo(-6.5, 6);
    expect(b[1]).toBeCloseTo(53.4, 6);
    expect(b[2]).toBeGreaterThan(b[0]);
    expect(b[3]).toBeGreaterThan(b[1]);
  });

  it("reads a MultiPolygon, which is how the sites layer publishes", () => {
    const a = site(-6.5, 53.4);
    const b = site(east(-6.5, 53.4, 100), 53.4);
    const multi = {
      type: "MultiPolygon",
      coordinates: [a.coordinates, b.coordinates],
    };
    const bounds = boundsOf(multi)!;
    // Spans both parts, not just the first.
    expect(footprintGapM(bounds, boundsOf(b)!)).toBe(0);
    expect(footprintGapM(bounds, boundsOf(a)!)).toBe(0);
  });

  it("returns null rather than a bogus extent for empty or broken geometry", () => {
    expect(boundsOf(null)).toBeNull();
    expect(boundsOf({ type: "Polygon", coordinates: [] })).toBeNull();
    expect(boundsOf({ type: "Polygon" })).toBeNull();
  });
});

describe("footprintGapM", () => {
  it("is zero when the outlines interleave", () => {
    // Two dwellings 35m apart whose site outlines overlap — Liskillea, Cork.
    const a = boundsOf(site(-8.55, 51.83, 60))!;
    const b = boundsOf(site(east(-8.55, 51.83, 20), 51.83, 60))!;
    expect(footprintGapM(a, b)).toBe(0);
  });

  it("measures the clear ground between separated outlines", () => {
    const a = boundsOf(site(-6.5, 53.4, 40))!;
    const b = boundsOf(site(east(-6.5, 53.4, 140), 53.4, 40))!;
    // 140m between the south-west corners, 40m of that is site A.
    expect(footprintGapM(a, b)).toBeGreaterThan(95);
    expect(footprintGapM(a, b)).toBeLessThan(105);
  });

  it("understates a diagonal separation rather than overstating it", () => {
    const a = boundsOf(site(-6.5, 53.4, 40))!;
    const b = boundsOf(site(east(-6.5, 53.4, 140), north(53.4, 140), 40))!;
    const gap = footprintGapM(a, b);
    // True separation is ~141m diagonally; we report the larger axis gap.
    // Erring low keeps a pair we are less sure about, which is the safe way.
    expect(gap).toBeLessThan(141);
    expect(gap).toBeGreaterThan(95);
  });

  it("is symmetric", () => {
    const a = boundsOf(site(-6.5, 53.4))!;
    const b = boundsOf(site(east(-6.5, 53.4, 300), 53.4))!;
    expect(footprintGapM(a, b)).toBeCloseTo(footprintGapM(b, a)!, 6);
  });

  it("has no answer when an extent is missing", () => {
    expect(footprintGapM(boundsOf(site(-6.5, 53.4)), null)).toBeNull();
  });
});

describe("sameSite", () => {
  const withGeom = (id: number, lng: number, lat: number, m = 40) => ({
    id,
    lat,
    lng,
    geom: site(lng, lat, m),
  });
  const extent = (a: { geom?: unknown }) => (a.geom ? boundsOf(a.geom) : null);

  it("keeps two works packages on one campus, however little they overlap", () => {
    // 26/2053 and 26/2054 — an ESB substation and a car park extension at the
    // North Cork Community Special School. Footprint overlap is 16%.
    const campus = withGeom(1, -8.42, 52.02, 200);
    const corner = withGeom(2, east(-8.42, 52.02, 150), north(52.02, 150), 40);
    expect(sameSite(campus, corner, extent)).toBe(true);
  });

  it("separates two dwellings in one townland that the 250m cap keeps", () => {
    // 26/1949 and 26/1950, Kennel, Youghal — 172m apart, outlines 54m clear.
    const a = withGeom(1, -7.85, 51.95, 50);
    const b = withGeom(2, east(-7.85, 51.95, 170), 51.95, 50);
    expect(sameSite(a, b, extent)).toBe(false);
  });

  it("relates a large holding whose centroids fall outside 250m", () => {
    // The case a fixed radius was always going to lose: sampled site diagonals
    // reach 721m, so the outlines adjoin while the centroids do not.
    const a = withGeom(1, -6.42, 52.55, 400);
    const b = withGeom(2, east(-6.42, 52.55, 410), 52.55, 400);
    // The sites are 410m apart corner to corner, so their recorded points are
    // well outside RELATED_MAX_KM — the centroid rule alone would drop this.
    expect(nearEnoughToRelate(a, b)).toBe(false);
    expect(sameSite(a, b, extent)).toBe(true);
  });

  it("treats digitising noise as one site", () => {
    const a = withGeom(1, -6.5, 53.4, 40);
    const b = withGeom(2, east(-6.5, 53.4, 40 + SITE_GAP_M - 5), 53.4, 40);
    expect(sameSite(a, b, extent)).toBe(true);
  });

  it("falls back to the centroid cap when either boundary is missing", () => {
    const near = { id: 1, lat: 53.4, lng: -6.5 };
    const alsoNear = { id: 2, lat: 53.4009, lng: -6.5 }; // ~100m
    const farAway = { id: 3, lat: 53.42, lng: -6.5 }; // ~2.2km
    expect(sameSite(near, alsoNear, extent)).toBe(true);
    expect(sameSite(near, farAway, extent)).toBe(false);
  });

  it("falls back when only one side has a boundary", () => {
    const mapped = withGeom(1, -6.5, 53.4);
    const unmapped = { id: 2, lat: 53.4, lng: -6.5 };
    expect(sameSite(mapped, unmapped, extent)).toBe(true);
  });

  it("is symmetric", () => {
    const a = withGeom(1, -6.5, 53.4, 50);
    const b = withGeom(2, east(-6.5, 53.4, 200), 53.4, 50);
    expect(sameSite(a, b, extent)).toBe(sameSite(b, a, extent));
  });
});
