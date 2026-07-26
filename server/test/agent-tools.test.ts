import { describe, expect, it } from "vitest";
import { AGENT_TOOLS, bboxAround, searchFiltersFromToolInput } from "../src/agent/tools.js";

describe("AGENT_TOOLS", () => {
  it("defines the eleven tools from the spec", () => {
    expect(AGENT_TOOLS.map((t) => t.name).sort()).toEqual([
      "count_applications",
      "geocode_location",
      "get_appeal",
      "get_application_detail",
      "get_conditions",
      "get_documents",
      "get_flood_risk",
      "get_zoning",
      "read_appeal_document",
      "read_document",
      "search_applications",
    ]);
  });

  it("every tool has a description and object input schema", () => {
    for (const t of AGENT_TOOLS) {
      expect(t.description.length).toBeGreaterThan(20);
      expect(t.input_schema.type).toBe("object");
    }
  });
});

describe("bboxAround", () => {
  it("returns [w,s,e,n] roughly km-sized around the point", () => {
    const [w, s, e, n] = bboxAround(53.38, -6.59, 1);
    expect(w).toBeLessThan(-6.59);
    expect(e).toBeGreaterThan(-6.59);
    expect(s).toBeLessThan(53.38);
    expect(n).toBeGreaterThan(53.38);
    // 1km ≈ 0.009 degrees latitude
    expect(n - s).toBeCloseTo(0.018, 2);
  });
});

describe("searchFiltersFromToolInput", () => {
  it("maps a full input", () => {
    const f = searchFiltersFromToolInput({
      query: "extension",
      statuses: ["granted", "refused"],
      domestic_only: true,
      appealed_only: false,
      near: { lat: 53.38, lng: -6.59 },
      radius_km: 2,
      received_from: "2022-01-01",
      limit: 10,
    });
    expect(f.q).toBe("extension");
    expect(f.statuses).toEqual(["granted", "refused"]);
    expect(f.domesticOnly).toBe(true);
    expect(f.appealedOnly).toBe(false);
    expect(f.near).toEqual({ lat: 53.38, lng: -6.59 });
    expect(f.bbox).toBeDefined();
    expect(f.sort).toBe("distance");
    expect(f.receivedFrom).toBe("2022-01-01");
    expect(f.limit).toBe(10);
    // Explicit statuses given → no junk exclusion.
    expect(f.excludeStatuses).toBeUndefined();
  });

  it("defaults: relevance sort without near, limit capped at 50, junk excluded", () => {
    const f = searchFiltersFromToolInput({ query: "shed", limit: 500 });
    expect(f.sort).toBe("relevance");
    expect(f.bbox).toBeUndefined();
    expect(f.limit).toBe(50);
    expect(f.excludeStatuses).toEqual(["invalid", "incomplete"]);
  });

  it("include_invalid keeps invalid/incomplete in scope", () => {
    const f = searchFiltersFromToolInput({ query: "shed", include_invalid: true });
    expect(f.excludeStatuses).toBeUndefined();
  });

  it("maps the sample-basis sort options", () => {
    expect(searchFiltersFromToolInput({ sort: "recent" }).sort).toBe("received");
    expect(searchFiltersFromToolInput({ sort: "relevance" }).sort).toBe("relevance");
    expect(searchFiltersFromToolInput({ sort: "nearest", near: { lat: 53, lng: -6 } }).sort).toBe("distance");
    // nearest without near still maps to distance (search treats it as non-distance mode)
    expect(searchFiltersFromToolInput({ near: { lat: 53, lng: -6 } }).sort).toBe("distance");
  });
});
