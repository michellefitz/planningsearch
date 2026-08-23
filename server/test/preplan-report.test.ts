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
    extractThemes: async () => JSON.stringify({
      condition_themes: [{ theme: "Matching finishes", examples: [{ reference: "23/1", address: "Maynooth", summary: "Match existing" }, { reference: "23/2", address: "Maynooth", summary: "Match existing" }] }],
      appeal_details: [{ reference: "23/2", address: "Maynooth", proposal: "Rear extension", council_decision: "Granted", appeal_outcome: "Upheld", what_changed: "No change" }],
      fi_themes: [],
    }),
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
  it("emits progress, all sections, narrative, done — in a valid order", async () => {
    const events = await collect(deps());
    expect(events[0]).toMatchObject({ type: "progress" });
    const sectionNames = events.filter((e) => e.type === "section").map((e) => (e as { name: string }).name);
    for (const name of ["site_constraints", "address_history", "nearby", "area_stats", "local_plan"]) {
      expect(sectionNames).toContain(name);
    }
    const last = events[events.length - 1];
    expect(last.type).toBe("done");
    const done = last as Extract<PreplanEvent, { type: "done" }>;
    expect(done.narrative).toContain("Site constraints");
    expect(Object.keys(done.sections).sort()).toEqual([
      "address_history",
      "area_stats",
      "local_plan",
      "nearby",
      "site_constraints",
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

  it("attaches condition themes and appeal details to the nearby section", async () => {
    const events = await collect(deps());
    const done = events[events.length - 1] as Extract<PreplanEvent, { type: "done" }>;
    const nearby = done.sections.nearby as {
      condition_themes: Array<{ theme: string }>;
      appeals: Array<{ reference: string }>;
      fi_themes: unknown[];
    };
    expect(nearby.condition_themes.length).toBeGreaterThan(0);
    expect(nearby.condition_themes[0].theme).toBe("Matching finishes");
    expect(nearby.appeals).toHaveLength(1);
    expect(nearby.appeals[0].reference).toBe("23/2");
    expect(events.some((e) => e.type === "progress" && /Extracting condition themes/.test((e as { step: string }).step))).toBe(true);
  });

  it("survives a throwing extractThemes gracefully", async () => {
    const events = await collect(
      deps({
        extractThemes: async () => { throw new Error("boom"); },
      })
    );
    const done = events[events.length - 1] as Extract<PreplanEvent, { type: "done" }>;
    const nearby = done.sections.nearby as { condition_themes: unknown[] };
    expect(nearby.condition_themes).toEqual([]);
    expect(done.type).toBe("done");
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
    expect(done.sections.site_constraints).toMatchObject({ unavailable: true });
    expect(done.sections.nearby).toMatchObject({ unavailable: true });
    expect(done.sections.area_stats).toMatchObject({ unavailable: true });
  });

  it("fills missing ai_summary from the batched summariser", async () => {
    const events = await collect(
      deps({
        summarisePrecedents: async (items) =>
          Object.fromEntries(items.map((it) => [it.planning_reference, "A short summary."])),
      })
    );
    const done = events[events.length - 1] as Extract<PreplanEvent, { type: "done" }>;
    const nearby = done.sections.nearby as { items: Array<{ ai_summary?: string | null }> };
    expect(nearby.items.every((p) => p.ai_summary === "A short summary.")).toBe(true);
  });

  it("a throwing summariser leaves items untouched and never sinks the report", async () => {
    const events = await collect(
      deps({
        summarisePrecedents: async () => {
          throw new Error("boom");
        },
      })
    );
    const done = events[events.length - 1] as Extract<PreplanEvent, { type: "done" }>;
    const nearby = done.sections.nearby as { items: Array<{ ai_summary?: string | null }> };
    expect(nearby.items.every((p) => p.ai_summary == null)).toBe(true);
    expect(done.type).toBe("done");
  });

  it("null narrative still finishes with done", async () => {
    const events = await collect(deps({ synthesise: async () => null }));
    const done = events[events.length - 1] as Extract<PreplanEvent, { type: "done" }>;
    expect(done.narrative).toBeNull();
    expect(events.filter((e) => e.type === "narrative")).toHaveLength(0);
  });
});
