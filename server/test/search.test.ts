import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDb, upsertApplication, type ApplicationRecord } from "../src/db.js";
import { aggregateApplications, buildFtsQuery, buildTrigramQuery, search, suggest } from "../src/search.js";
import type Database from "better-sqlite3";

const base: ApplicationRecord = {
  authority_id: "kildare",
  planning_reference: "25/456",
  description: "Construction of a single storey extension to the rear of the existing dwelling",
  application_type: "permission",
  application_type_raw: "Permission",
  is_domestic_guess: 1,
  status: "pending",
  status_raw: "New Application",
  received_date: "2026-05-01",
  validated_date: null,
  further_info_requested_date: null,
  further_info_received_date: null,
  decision_due_date: "2026-06-26",
  decision: null,
  decision_raw: null,
  decision_date: null,
  appeal_status: null,
  appeal_reference: null,
  appeal_lodged_date: null,
  appeal_decision: null,
  appeal_decision_date: null,
  final_grant_date: null,
  applicant_name: "Mary Delaney",
  agent_name: null,
  address_text: "14 Mill Lane, Maynooth, Co. Kildare",
  eircode: null,
  num_residential_units: null,
  floor_area_sqm: null,
  site_area_ha: null,
  expiry_date: null,
  lat: 53.3813,
  lng: -6.5919,
  geom_polygon: null,
  source_url: null,
  last_synced: "2026-07-18T00:00:00Z",
};

let db: Database.Database;
let tmpDir: string;

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "planview-test-"));
  db = openDb(path.join(tmpDir, "test.db"));
  upsertApplication(db, base);
  upsertApplication(db, {
    ...base,
    planning_reference: "F26A/0102",
    authority_id: "fingal",
    status: "granted",
    decision: "Grant Permission",
    decision_date: "2026-03-10",
    address_text: "8 Harbour Road, Skerries, Co. Dublin",
    applicant_name: "John O'Shea",
    description: "Two storey extension to the side of the existing dwelling house",
    lat: 53.5828,
    lng: -6.1083,
  });
  upsertApplication(db, {
    ...base,
    planning_reference: "3921/26",
    authority_id: "dublin-city",
    status: "refused",
    is_domestic_guess: 0,
    description: "Construction of a two storey office block with basement car parking",
    address_text: "22 Chapel Lane, Rathmines, Dublin 6",
    lat: 53.3211,
    lng: -6.2654,
  });
  upsertApplication(db, {
    ...base,
    planning_reference: "F26A/0311",
    authority_id: "fingal",
    status: "appealed",
    appeal_reference: "ABP-319506-26",
    appeal_status: "Appeal lodged with An Bord Pleanála",
    address_text: "5 Strand Street, Malahide, Co. Dublin",
    lat: 53.4508,
    lng: -6.1547,
  });
});

afterAll(() => {
  db.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("query builders", () => {
  it("quotes tokens with slashes so planning references survive FTS syntax", () => {
    expect(buildFtsQuery("25/456")).toBe('"25/456"*');
  });
  it("adds prefix search to the final token", () => {
    expect(buildFtsQuery("mill lane mayn")).toBe('"mill" "lane" "mayn"*');
  });
  it("builds trigram OR queries", () => {
    expect(buildTrigramQuery("manooth")).toContain('"man" OR');
  });
});

describe("search", () => {
  it("finds by exact planning reference", () => {
    const { results } = search(db, { q: "25/456" });
    expect(results).toHaveLength(1);
    expect(results[0].planning_reference).toBe("25/456");
    expect(results[0].match_quality).toBe("exact");
  });

  it("finds by address across authorities", () => {
    const { results } = search(db, { q: "Maynooth" });
    expect(results.some((r) => r.address_text?.includes("Maynooth"))).toBe(true);
  });

  it("tolerates typos via the trigram fallback (F1.3)", () => {
    const { results, fuzzy } = search(db, { q: "manooth" });
    expect(fuzzy).toBe(true);
    expect(results.some((r) => r.address_text?.includes("Maynooth"))).toBe(true);
  });

  it("filters by status and authority", () => {
    const { results } = search(db, { statuses: ["granted"], authorities: ["fingal"] });
    expect(results).toHaveLength(1);
    expect(results[0].planning_reference).toBe("F26A/0102");
  });

  it("filters by domestic heuristic", () => {
    const { results } = search(db, { domesticOnly: true });
    expect(results.every((r) => r.is_domestic_guess === 1)).toBe(true);
  });

  it("restricts to applications with an appeal on record", () => {
    const { results } = search(db, { appealedOnly: true });
    expect(results).toHaveLength(1);
    expect(results[0].planning_reference).toBe("F26A/0311");
    expect(results[0].appeal_reference).toBe("ABP-319506-26");
  });

  it("restricts to a bounding box (search this area, F1.4)", () => {
    const { results } = search(db, { bbox: [-6.7, 53.3, -6.4, 53.45] });
    expect(results).toHaveLength(1);
    expect(results[0].authority_id).toBe("kildare");
  });

  it("computes distance for near-me sorting", () => {
    const { results } = search(db, {
      near: { lat: 53.3813, lng: -6.5919 },
      sort: "distance",
    });
    expect(results[0].planning_reference).toBe("25/456");
    expect(results[0].distance_km).toBeLessThan(1);
  });
});

describe("aggregateApplications", () => {
  it("counts the whole matching set with breakdowns", () => {
    const agg = aggregateApplications(db, {});
    expect(agg.total).toBe(4);
    expect(agg.granted).toBe(1);
    expect(agg.refused).toBe(1);
    expect(agg.by_status.pending).toBe(1);
    expect(agg.by_status.appealed).toBe(1);
    expect(agg.appealed).toBe(1);
    // Breaks down by planning authority (2 fingal, 1 kildare, 1 dublin-city).
    expect(agg.by_authority.fingal).toBe(2);
    expect(agg.by_authority.kildare).toBe(1);
    expect(agg.by_authority["dublin-city"]).toBe(1);
  });

  it("respects excludeStatuses (junk filtering)", () => {
    const agg = aggregateApplications(db, { excludeStatuses: ["pending", "appealed"] });
    expect(agg.total).toBe(2);
    expect(agg.by_status.pending).toBeUndefined();
    expect(agg.granted).toBe(1);
    expect(agg.refused).toBe(1);
  });

  it("counts over a keyword-filtered set", () => {
    const agg = aggregateApplications(db, { q: "extension" });
    expect(agg.total).toBeGreaterThan(0);
    expect(agg.total).toBeLessThanOrEqual(4);
  });
});

describe("search excludeStatuses", () => {
  it("drops excluded statuses from results and total", () => {
    const { results, total } = search(db, { excludeStatuses: ["pending", "appealed"] });
    expect(total).toBe(2);
    expect(results.every((r) => r.status !== "pending" && r.status !== "appealed")).toBe(true);
  });
});

describe("suggest", () => {
  it("returns address suggestions for partial input", () => {
    const suggestions = suggest(db, "mayn");
    expect(suggestions.some((s) => s.includes("Maynooth"))).toBe(true);
  });
});
