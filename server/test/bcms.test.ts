import { describe, expect, it } from "vitest";
import { lookupCommencement, refVariants, type Commencement } from "../src/ingest/bcms.js";

describe("refVariants", () => {
  it("canonicalises real formats from the BCMS dataset", () => {
    expect(refVariants("WEB2286/26")).toEqual(["WEB228626"]);
    expect(refVariants("F24A/0839E")).toEqual(["F24A0839E"]);
    expect(refVariants("SDZ24A/0029W")).toEqual(["SDZ24A0029W", "SDZ24A0029"]);
    expect(refVariants("D25A/0678/WEB")).toEqual(["D25A0678WEB", "D25A0678"]);
    expect(refVariants("abp-313252-22")).toEqual(["ABP31325222"]);
    expect(refVariants("^21/1231^")).toEqual(["211231"]);
  });
  it("does not strip a W that is part of the series prefix", () => {
    // FW = Fingal West series — the W here is not a web-submission marker.
    expect(refVariants("FW26A/0280E")).toEqual(["FW26A0280E"]);
  });
  it("rejects junk too short to be a reference", () => {
    expect(refVariants("2.")).toEqual([]);
    expect(refVariants("N/A")).toEqual([]);
    expect(refVariants(null)).toEqual([]);
  });
});

describe("lookupCommencement", () => {
  const cn: Commencement = {
    notice: "CN0132991DR",
    commencement_date: "2025-09-11",
    completion_date: null,
    units: 8,
    count: 1,
  };
  const index = new Map<string, Commencement>([
    ["dlr:D25A0678", cn],
    ["dlr:ABP31325222", cn],
  ]);

  it("matches across web-submission suffix differences", () => {
    // Register says D25A/0678; BCMS filed it as D25A/0678/WEB (indexed stripped).
    expect(lookupCommencement(index, "dlr", "D25A/0678")).toBe(cn);
    expect(lookupCommencement(index, "dlr", "D25A/0678/WEB")).toBe(cn);
  });
  it("falls back to the An Bord Pleanála reference", () => {
    expect(lookupCommencement(index, "dlr", "D22A/0999", "ABP-313252-22")).toBe(cn);
  });
  it("scopes matches to the authority", () => {
    expect(lookupCommencement(index, "fingal", "D25A/0678")).toBeNull();
  });
});
