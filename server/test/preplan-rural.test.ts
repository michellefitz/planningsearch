import { describe, expect, it } from "vitest";
import {
  classifyRefusalThemes,
  isOneOffIntent,
  localNeedQuote,
  oneOffRates,
  RURAL_REFUSAL_THEMES,
} from "../../api/_preplan/pipeline.mjs";

/** Verbatim from DLR D08A/1246, a refused one-off house. */
const REAL_REFUSAL =
  "The site of the proposed development is located in an area zoned 'G' in the 2004-2010 Dun " +
  "Laoghaire-Rathdown County Development Plan with the objective 'to protect and improve high " +
  "amenity areas'. It is the policy of the Council that dwellings will only be permitted on " +
  "suitable sites where the applicant can demonstrate a genuine need for housing in the area as " +
  "their principal employment is in agriculture, hill farming or local industry and local crafts. " +
  "The applicant has failed to submit sufficient information to demonstrate the suitability of the " +
  "soil on site for the treatment and disposal of effluent from the proposed septic tank waste " +
  "water treatment system. Due to inadequate sightlines onto Kellystown Road and the narrowness of " +
  "the existing roadway, the proposal would endanger public safety by reason of traffic hazard.";

describe("isOneOffIntent", () => {
  it("recognises building a house on a site", () => {
    for (const intent of [
      "Build a house on our site",
      "construct a new dwelling on family land",
      "I want to erect a bungalow",
      "one-off house in the countryside",
      "self build on a green field site",
    ]) {
      expect(isOneOffIntent(intent)).toBe(true);
    }
  });

  it("does not fire for work on a house that exists", () => {
    // None of the rural tests apply to an extension, so the section would be
    // noise at best and misleading at worst.
    for (const intent of [
      "Convert the attic with a rear dormer",
      "Extension to the rear of our house",
      "Build a garage beside the house",
      "Retention of a porch",
      "Solar panels on the roof",
    ]) {
      expect(isOneOffIntent(intent)).toBe(false);
    }
  });
});

describe("classifyRefusalThemes", () => {
  it("reads the tests out of a real refusal", () => {
    const themes = classifyRefusalThemes(REAL_REFUSAL);
    expect(themes).toContain("local_need");
    expect(themes).toContain("zoning");
    expect(themes).toContain("wastewater");
    expect(themes).toContain("access");
  });

  it("claims nothing from nothing", () => {
    expect(classifyRefusalThemes("")).toEqual([]);
    expect(classifyRefusalThemes(null)).toEqual([]);
    // A routine condition is not a rural refusal reason.
    expect(classifyRefusalThemes("The developer shall pay a contribution of €5,000.")).toEqual([]);
  });

  it("every theme has a label a non-planner can read", () => {
    for (const t of RURAL_REFUSAL_THEMES) {
      expect(t.label.length).toBeGreaterThan(10);
      expect(t.label).not.toMatch(/^[a-z_]+$/);
    }
  });
});

describe("localNeedQuote", () => {
  it("returns the council's own wording of the test", () => {
    const q = localNeedQuote(REAL_REFUSAL)!;
    expect(q).toContain("genuine need for housing in the area");
    // A quote, not a paragraph.
    expect(q.length).toBeLessThanOrEqual(400);
  });

  it("returns null rather than a quote that says nothing", () => {
    expect(localNeedQuote("Refused. See attached.")).toBeNull();
    expect(localNeedQuote("")).toBeNull();
  });
});

describe("oneOffRates", () => {
  const at = (lat: number, lng: number, extra: Record<string, unknown>) => ({
    lat, lng, is_one_off: 0, decision: null, received_date: null, decision_date: null,
    appeal_reference: null, ...extra,
  });
  // Two refused one-off houses beside the site, one granted, plus ordinary
  // applications that mostly get through — the real shape of the register.
  const rows = [
    at(53.30, -6.60, { is_one_off: 1, decision: "REFUSE PERMISSION" }),
    at(53.30, -6.60, { is_one_off: 1, decision: "REFUSE PERMISSION" }),
    at(53.30, -6.60, { is_one_off: 1, decision: "GRANT PERMISSION" }),
    // Far away: inside the authority, outside the radius.
    at(54.50, -8.00, { is_one_off: 1, decision: "GRANT PERMISSION" }),
    ...Array.from({ length: 9 }, () => at(53.30, -6.60, { decision: "GRANT PERMISSION" })),
    at(53.30, -6.60, { decision: "REFUSE PERMISSION" }),
  ];

  it("contrasts one-off houses with everything else the council decides", () => {
    const r = oneOffRates(rows, 53.30, -6.60);
    expect(r.within_radius.grant_rate).toBe(33);
    expect(r.authority_one_off.grant_rate).toBe(50);
    // The baseline is what makes the number mean something: 11 granted of the
    // 14 decided, one-off houses included.
    expect(r.authority_all.grant_rate).toBe(79);
  });

  it("keeps distant one-off houses out of the local figure", () => {
    const r = oneOffRates(rows, 53.30, -6.60);
    expect(r.within_radius.decided).toBe(3);
    expect(r.authority_one_off.decided).toBe(4);
  });

  it("reports no rate rather than a made-up one", () => {
    const r = oneOffRates([], 53.3, -6.6);
    expect(r.within_radius.grant_rate).toBeNull();
    expect(r.authority_all.grant_rate).toBeNull();
  });
});
