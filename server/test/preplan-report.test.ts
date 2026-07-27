import { describe, expect, it } from "vitest";
import { generateReport, type PreplanEvent, type ReportDeps } from "../src/preplan/report.js";
import type { PrecedentSourceRow } from "../src/preplan/precedents.js";

const INPUT = { lat: 53.3813, lng: -6.5918, address: "Maynooth", intent: "rear extension" };

function row(over: Partial<PrecedentSourceRow>): PrecedentSourceRow {
  return {
    authority_id: "kildare",
    planning_reference: "23/1",
    description: "rear extension to dwelling",
    status: "granted",
    decision: "Grant Permission",
    decision_date: "2023-06-01",
    received_date: "2023-03-01",
    address_text: "Maynooth",
    lat: 53.3814,
    lng: -6.5918,
    appeal_reference: null,
    ...over,
  };
}

function deps(over: Partial<ReportDeps> = {}): ReportDeps {
  return {
    getDesignations: async () => ({ items: [], checked: ["zoning"], failed: [] }),
    getHeritagePoints: async () => ({ niah: [], smr: [] }),
    getFloodGround: async () => ({
      flood: { at_risk: false, scenarios: [] },
      groundwater: null,
      radon: { unavailable: true, reason: "x" },
    }),
    getRows: async () => ({
      nearby: [row({}), row({ planning_reference: "23/2", appeal_reference: "ABP-1" })],
      authority: [row({})],
      authority_id: "kildare",
    }),
    readPrecedentDocument: async () => ({ document: "Inspector's report", answer: "Recommended grant." }),
    synthesise: async () => "**Site constraints**\n\nNone of note.",
    ...over,
  };
}

async function collect(d: ReportDeps): Promise<PreplanEvent[]> {
  const events: PreplanEvent[] = [];
  for await (const ev of generateReport(INPUT, d)) events.push(ev);
  return events;
}

describe("generateReport", () => {
  it("emits progress, all six sections, narrative, done — in a valid order", async () => {
    const events = await collect(deps());
    expect(events[0]).toMatchObject({ type: "progress" });
    const sectionNames = events.filter((e) => e.type === "section").map((e) => (e as { name: string }).name);
    for (const name of ["designations", "heritage_points", "flood_ground", "precedents", "area_stats", "local_plan"]) {
      expect(sectionNames).toContain(name);
    }
    const last = events[events.length - 1];
    expect(last.type).toBe("done");
    const done = last as Extract<PreplanEvent, { type: "done" }>;
    expect(done.narrative).toContain("Site constraints");
    expect(Object.keys(done.sections).sort()).toEqual([
      "area_stats",
      "designations",
      "flood_ground",
      "heritage_points",
      "local_plan",
      "precedents",
    ]);
    expect(done.sections.local_plan).toMatchObject({ authority_id: "kildare", url: expect.stringContaining("kildare") });
  });

  it("local_plan is unavailable when the authority has no known plan link", async () => {
    const events = await collect(
      deps({
        getRows: async () => ({ nearby: [row({})], authority: [row({})], authority_id: "nowhere" }),
      })
    );
    const done = events[events.length - 1] as Extract<PreplanEvent, { type: "done" }>;
    expect(done.sections.local_plan).toMatchObject({ unavailable: true });
  });

  it("attaches deep-dive extracts to the precedents section", async () => {
    const events = await collect(deps());
    const done = events[events.length - 1] as Extract<PreplanEvent, { type: "done" }>;
    const prec = done.sections.precedents as { deep_dives: Array<{ extract: string }> };
    expect(prec.deep_dives.length).toBeGreaterThan(0);
    expect(prec.deep_dives[0].extract).toBe("Recommended grant.");
    // Progress mentioned the reference being read.
    expect(events.some((e) => e.type === "progress" && /Reading the decision documents/.test(e.step))).toBe(true);
  });

  it("caps deep dives at 3 and survives a reader that throws", async () => {
    const nearby = Array.from({ length: 6 }, (_, i) =>
      row({ planning_reference: `23/${i}`, description: "rear extension" })
    );
    let reads = 0;
    const events = await collect(
      deps({
        getRows: async () => ({ nearby, authority: nearby }),
        readPrecedentDocument: async () => {
          reads++;
          if (reads === 2) throw new Error("boom");
          return { document: "Decision order", answer: "ok" };
        },
      })
    );
    expect(reads).toBe(3);
    const done = events[events.length - 1] as Extract<PreplanEvent, { type: "done" }>;
    expect((done.sections.precedents as { deep_dives: unknown[] }).deep_dives).toHaveLength(2);
  });

  it("a rejecting gatherer becomes an unavailable section, not a crash", async () => {
    const events = await collect(
      deps({
        getDesignations: async () => {
          throw new Error("net down");
        },
        getRows: async () => {
          throw new Error("db down");
        },
      })
    );
    const done = events[events.length - 1] as Extract<PreplanEvent, { type: "done" }>;
    expect(done.sections.designations).toMatchObject({ unavailable: true });
    expect(done.sections.precedents).toMatchObject({ unavailable: true });
    expect(done.sections.area_stats).toMatchObject({ unavailable: true });
  });

  it("null narrative still finishes with done", async () => {
    const events = await collect(deps({ synthesise: async () => null }));
    const done = events[events.length - 1] as Extract<PreplanEvent, { type: "done" }>;
    expect(done.narrative).toBeNull();
    expect(events.filter((e) => e.type === "narrative")).toHaveLength(0);
  });
});
