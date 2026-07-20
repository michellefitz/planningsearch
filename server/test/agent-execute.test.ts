import { describe, expect, it } from "vitest";
import { buildToolExecutor, toolAppSummary } from "../src/agent/execute.js";

const ROW = {
  id: 42, authority_id: "kildare", planning_reference: "23/123",
  description: "Two storey rear extension", status: "granted",
  application_type: "permission", is_domestic_guess: 1,
  received_date: "2023-02-01", decision: "Grant Permission", decision_date: "2023-05-01",
  address_text: "1 Main St, Maynooth", lat: 53.38, lng: -6.59,
  appeal_reference: null,
};

const fakeDb = {
  prepare: () => ({ get: (id: number) => (id === 42 ? ROW : undefined) }),
} as never;

function exec(deps: Record<string, unknown>) {
  return buildToolExecutor(fakeDb, deps as never);
}

describe("toolAppSummary", () => {
  it("trims a row to the summary shape with a status label", () => {
    const s = toolAppSummary(ROW as never);
    expect(s).toMatchObject({
      id: 42, planning_reference: "23/123", status: "granted",
      status_label: "Granted", address_text: "1 Main St, Maynooth", lat: 53.38,
    });
    expect(s).not.toHaveProperty("geom_polygon");
  });
});

describe("buildToolExecutor", () => {
  it("search_applications maps input and returns summaries", async () => {
    const run = exec({
      search: (_db: never, f: { q?: string }) => {
        expect(f.q).toBe("extension");
        return { results: [ROW], total: 1, fuzzy: false };
      },
    });
    const out = (await run("search_applications", { query: "extension" })) as {
      total: number; results: Array<{ id: number }>;
    };
    expect(out.total).toBe(1);
    expect(out.results[0].id).toBe(42);
  });

  it("get_conditions reports unavailable for non-agile councils", async () => {
    const run = exec({});
    const out = (await run("get_conditions", { application_id: 42 })) as { available: boolean };
    expect(out.available).toBe(false);
  });

  it("get_appeal explains when there is no appeal", async () => {
    const run = exec({});
    const out = (await run("get_appeal", { application_id: 42 })) as { error: string };
    expect(out.error).toMatch(/no appeal/i);
  });

  it("geocode_location returns the first located search hit", async () => {
    const run = exec({
      search: () => ({ results: [ROW], total: 1, fuzzy: true }),
    });
    const out = (await run("geocode_location", { location: "maynooth" })) as {
      lat: number; authority_id: string; confidence: string;
    };
    expect(out.lat).toBe(53.38);
    expect(out.authority_id).toBe("kildare");
    expect(out.confidence).toBe("approximate");
  });

  it("unknown tool → error object, not a throw", async () => {
    const run = exec({});
    const out = (await run("no_such_tool", {})) as { error: string };
    expect(out.error).toMatch(/unknown tool/i);
  });
});
