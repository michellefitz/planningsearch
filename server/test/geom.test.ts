import { describe, expect, it } from "vitest";
import {
  multiPolygonAreaSqm,
  ringAreaSqm,
  ringsToMultiPolygon,
  simplifyMultiPolygon,
  simplifyRing,
} from "../src/ingest/geom.js";

/**
 * A real Dublin City site boundary (application 2343/19) at full precision,
 * fetched from layer 1 of the national service. The council publishes
 * AreaofSite = 296.18 m² for it, which is the ground truth the geodesic area
 * has to reproduce — the whole point of measuring rather than trusting the
 * field is that it has to be at least as accurate as the field it replaces.
 */
const DUBLIN_SITE_RING = [
  [-6.22181787358087, 53.373269878132],
  [-6.22201523442457, 53.3732598775135],
  [-6.2221019392688, 53.3732552379642],
  [-6.2221408291702, 53.3732529420178],
  [-6.2222219063593, 53.3731692209731],
  [-6.22224111391632, 53.3731484766709],
  [-6.22230615382498, 53.3731700265306],
  [-6.22227879418484, 53.3731960413886],
  [-6.22206734359715, 53.3734102909197],
  [-6.22198266382705, 53.3733693054105],
  [-6.22191445810754, 53.3733315313719],
  [-6.22185403306896, 53.3732944125102],
  [-6.22181903643959, 53.3732716921857],
  [-6.22181787358087, 53.373269878132],
];
const DUBLIN_SITE_PUBLISHED_SQM = 296.18;

describe("ringAreaSqm", () => {
  it("matches the council's own published site area", () => {
    const area = ringAreaSqm(DUBLIN_SITE_RING);
    expect(area).toBeGreaterThan(DUBLIN_SITE_PUBLISHED_SQM * 0.99);
    expect(area).toBeLessThan(DUBLIN_SITE_PUBLISHED_SQM * 1.01);
  });

  it("is orientation-independent", () => {
    const reversed = [...DUBLIN_SITE_RING].reverse();
    expect(ringAreaSqm(reversed)).toBeCloseTo(ringAreaSqm(DUBLIN_SITE_RING), 6);
  });

  it("measures a one-hectare square to within a fraction of a percent", () => {
    // 100 m at 53.35°N: 100/111132.92 degrees of latitude, and the same ground
    // distance east-west is longer in degrees by 1/cos(lat).
    const lat = 53.35;
    const dLat = 100 / 111132.92;
    const dLng = 100 / (111319.49 * Math.cos((lat * Math.PI) / 180));
    const square = [
      [0, lat],
      [dLng, lat],
      [dLng, lat + dLat],
      [0, lat + dLat],
      [0, lat],
    ];
    expect(ringAreaSqm(square)).toBeGreaterThan(9_950);
    expect(ringAreaSqm(square)).toBeLessThan(10_050);
  });
});

describe("multiPolygonAreaSqm", () => {
  it("subtracts holes from the enclosing ring", () => {
    const outer = ringsToMultiPolygon([DUBLIN_SITE_RING])!;
    const solid = multiPolygonAreaSqm(outer);
    // Shrink the ring about its first vertex to make a hole strictly inside it.
    const [ox, oy] = DUBLIN_SITE_RING[0];
    const hole = DUBLIN_SITE_RING.map(([x, y]) => [ox + (x - ox) * 0.5, oy + (y - oy) * 0.5]);
    const withHole = multiPolygonAreaSqm([[outer[0][0], hole]]);
    // A half-scale hole removes a quarter of the area.
    expect(withHole).toBeGreaterThan(solid * 0.7);
    expect(withHole).toBeLessThan(solid * 0.8);
  });

  it("never returns a negative area", () => {
    expect(multiPolygonAreaSqm([])).toBe(0);
  });
});

describe("simplifyRing", () => {
  it("drops vertices that sit on a straight edge", () => {
    // A square with three redundant points along its northern edge.
    const lat = 53.35;
    const ring = [
      [0, lat],
      [0.001, lat],
      [0.001, lat + 0.001],
      [0.00075, lat + 0.001],
      [0.0005, lat + 0.001],
      [0.00025, lat + 0.001],
      [0, lat + 0.001],
      [0, lat],
    ];
    expect(simplifyRing(ring, 2)).toHaveLength(5);
  });

  it("leaves a small site's true corners alone", () => {
    // The whole risk of simplifying is flattening a real boundary. This site is
    // ~300 m²; at a 2 m tolerance its area must survive nearly intact.
    const simplified = simplifyRing(DUBLIN_SITE_RING, 2);
    expect(ringAreaSqm(simplified)).toBeGreaterThan(ringAreaSqm(DUBLIN_SITE_RING) * 0.95);
  });

  it("returns the ring untouched rather than degenerating it", () => {
    const triangle = [
      [0, 53.35],
      [0.0000001, 53.35],
      [0, 53.3500001],
      [0, 53.35],
    ];
    expect(simplifyRing(triangle, 50)).toEqual(triangle);
  });
});

describe("simplifyMultiPolygon", () => {
  it("simplifies every ring and keeps the structure", () => {
    const coords = ringsToMultiPolygon([DUBLIN_SITE_RING])!;
    const out = simplifyMultiPolygon(coords, 2)!;
    expect(out).toHaveLength(1);
    expect(out[0]).toHaveLength(1);
    expect(out[0][0].length).toBeLessThanOrEqual(coords[0][0].length);
    // Closed ring in, closed ring out.
    expect(out[0][0][0]).toEqual(out[0][0][out[0][0].length - 1]);
  });

  it("returns null for nothing usable", () => {
    expect(simplifyMultiPolygon([], 2)).toBeNull();
  });
});
