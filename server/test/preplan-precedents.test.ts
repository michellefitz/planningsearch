import { describe, expect, it } from "vitest";
import {
  areaStats,
  deepDiveCandidates,
  intentTokens,
  selectPrecedents,
  type PrecedentSourceRow,
} from "../src/preplan/precedents.js";

function row(over: Partial<PrecedentSourceRow>): PrecedentSourceRow {
  return {
    authority_id: "kildare",
    planning_reference: "23/1",
    description: "extension to dwelling",
    status: "granted",
    decision: "Grant Permission",
    decision_date: "2023-06-01",
    received_date: "2023-03-01",
    address_text: "Maynooth",
    lat: 53.3813,
    lng: -6.5918,
    appeal_reference: null,
    ...over,
  };
}

describe("intentTokens", () => {
  it("drops stopwords, short words and duplicates", () => {
    expect(intentTokens("I want to build an attic conversion with rear dormer dormer")).toEqual([
      "attic",
      "conversion",
      "rear",
      "dormer",
    ]);
  });
});

describe("selectPrecedents", () => {
  const base = { lat: 53.3813, lng: -6.5918 };
  it("prefers keyword matches nearby, enforces the 1km radius", () => {
    const rows = [
      row({ planning_reference: "far", lat: 53.5 }), // >1km, excluded
      row({ planning_reference: "near-plain", description: "agricultural shed", lat: 53.3814 }),
      row({ planning_reference: "near-match", description: "attic conversion and rear dormer", lat: 53.3830 }),
    ];
    const out = selectPrecedents(rows, base.lat, base.lng, "attic conversion with a rear dormer");
    expect(out.map((p) => p.planning_reference)).toEqual(["near-match", "near-plain"]);
    expect(out[0].keyword_hits).toContain("dormer");
    expect(out[0].distance_m).toBeGreaterThan(0);
  });

  it("caps at limit", () => {
    const rows = Array.from({ length: 20 }, (_, i) => row({ planning_reference: `r${i}`, lat: 53.3814 }));
    expect(selectPrecedents(rows, base.lat, base.lng, "extension", 8)).toHaveLength(8);
  });
});

describe("deepDiveCandidates", () => {
  it("prefers appealed cases, then score; skips undecided", () => {
    const scored = selectPrecedents(
      [
        row({ planning_reference: "undecided", decision: null, status: "lodged", lat: 53.3814 }),
        row({ planning_reference: "decided", lat: 53.3814 }),
        row({ planning_reference: "appealed", appeal_reference: "ABP-1", lat: 53.39, description: "shed" }),
      ],
      53.3813,
      -6.5918,
      "extension"
    );
    const out = deepDiveCandidates(scored, 3);
    expect(out[0].planning_reference).toBe("appealed");
    expect(out.map((p) => p.planning_reference)).not.toContain("undecided");
  });
});

describe("areaStats", () => {
  it("computes rates on decided apps only and medians correctly", () => {
    const rows = [
      row({}), // granted, 92 days
      row({ decision: "REFUSE PERMISSION", received_date: "2023-01-01", decision_date: "2023-03-02" }), // 60 days
      row({ decision: null, status: "lodged", decision_date: null }),
      row({ appeal_reference: "ABP-2", received_date: "2023-01-01", decision_date: "2023-05-11" }), // granted, 130 days
      row({ lat: 54.0 }), // authority-wide but outside 2km
    ];
    const out = areaStats(rows, 53.3813, -6.5918);
    expect(out.authority.total).toBe(5);
    expect(out.authority.decided).toBe(4);
    expect(out.authority.grant_rate).toBe(75);
    expect(out.authority.appealed).toBe(1);
    expect(out.authority.median_decision_days).toBe(92); // median of 92,60,130,92
    expect(out.within_2km.total).toBe(4);
  });

  it("null rates on empty/undecided sets", () => {
    const out = areaStats([row({ decision: null, decision_date: null })], 53.3813, -6.5918);
    expect(out.authority.grant_rate).toBeNull();
    expect(out.authority.median_decision_days).toBeNull();
  });
});
