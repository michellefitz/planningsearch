import { describe, expect, it } from "vitest";
import { fillMissingCoordinates } from "../src/coordinates.js";

/**
 * 20 Glen Easton Gardens, Leixlip. Three applications at one house: two that
 * the build managed to locate, and the live one whose detail-page fetch failed,
 * leaving it in the list and off the map. Reported missing twice.
 */
const GLEN_EASTON = () => [
  {
    authority_id: "kildare",
    planning_reference: "2660786",
    address_text: "20, Glen Easton Gardens, Leixlip",
    lat: 53.36856192849647,
    lng: -6.518628898867135,
  },
  {
    authority_id: "kildare",
    planning_reference: "2660794",
    address_text: "20, Glen Easton Gardens, Leixlip",
    lat: 53.36859000842353,
    lng: -6.518592140792264,
  },
  {
    authority_id: "kildare",
    planning_reference: "2660804",
    address_text: "20 Glen Easton Gardens, Leixlip, Co. Kildare",
    lat: null,
    lng: null,
  },
];

describe("fillMissingCoordinates", () => {
  it("gives the unlocated application the pin its neighbours on the file already have", () => {
    const records = GLEN_EASTON();
    expect(fillMissingCoordinates(records)).toBe(1);
    // The county suffix and the comma differ; the address key does not.
    expect(records[2].lat).toBeCloseTo(53.36856, 5);
    expect(records[2].lng).toBeCloseTo(-6.51863, 5);
  });

  it("leaves records that already have a pin exactly as they are", () => {
    const records = GLEN_EASTON();
    fillMissingCoordinates(records);
    expect(records[0].lat).toBe(53.36856192849647);
    expect(records[1].lat).toBe(53.36859000842353);
  });

  it("never crosses councils, since references and addresses both repeat", () => {
    const records = [
      { authority_id: "meath", address_text: "20 Glen Easton Gardens, Leixlip", lat: 53.6, lng: -6.7 },
      { authority_id: "kildare", address_text: "20 Glen Easton Gardens, Leixlip", lat: null, lng: null },
    ];
    expect(fillMissingCoordinates(records)).toBe(0);
    expect(records[1].lat).toBeNull();
  });

  /**
   * A townland is shared by many houses, so its centroid is a pin on the wrong
   * one — worse than no pin at all on a map people use to check what is being
   * built beside them.
   */
  it("will not place a pin from an address without a number", () => {
    const records = [
      { authority_id: "kildare", address_text: "Ticknevin, Carbury, Co. Kildare", lat: 53.3, lng: -7.0 },
      { authority_id: "kildare", address_text: "Ticknevin, Carbury, Co. Kildare", lat: null, lng: null },
    ];
    expect(fillMissingCoordinates(records)).toBe(0);
    expect(records[1].lat).toBeNull();
  });

  it("does nothing when there is nothing at the address to copy from", () => {
    const records = [
      { authority_id: "kildare", address_text: "1 Nowhere Lane, Naas", lat: null, lng: null },
      { authority_id: "kildare", address_text: null, lat: null, lng: null },
    ];
    expect(fillMissingCoordinates(records)).toBe(0);
  });

  it("treats a half-located record as unlocated", () => {
    // A latitude with no longitude puts a pin on the prime meridian.
    const records = [
      { authority_id: "kildare", address_text: "5 Main Street, Naas", lat: 53.2, lng: -6.6 },
      { authority_id: "kildare", address_text: "5 Main Street, Naas", lat: 53.2, lng: null },
    ];
    expect(fillMissingCoordinates(records)).toBe(1);
    expect(records[1].lng).toBe(-6.6);
  });
});
