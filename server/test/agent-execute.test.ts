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

  it("surfaces appeal_reference when the row has one", () => {
    const s = toolAppSummary({ ...ROW, appeal_reference: "ABP-319506-26" } as never);
    expect(s.appeal_reference).toBe("ABP-319506-26");
    expect(toolAppSummary(ROW as never).appeal_reference).toBeNull();
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

  it("get_documents falls back to the Agile listing for fingal", async () => {
    const fingalRow = { ...ROW, id: 43, authority_id: "fingal", planning_reference: "F23/456", source_url: null };
    const db = { prepare: () => ({ get: (id: number) => (id === 43 ? fingalRow : undefined) }) } as never;
    const run = buildToolExecutor(db, {
      fetchAgileDocumentList: async (authorityId: string) => {
        expect(authorityId).toBe("fingal");
        return {
          files: [{ title: "Site Plan", url: "x" }, { title: "Decision Order", url: "y" }],
          applicationUrl: "https://example.com/app/1",
        };
      },
    } as never);
    const out = (await run("get_documents", { application_id: 43 })) as {
      count: number; files: Array<{ title: string }>;
    };
    expect(out.count).toBe(2);
    expect(out.files).toEqual([{ title: "Site Plan" }, { title: "Decision Order" }]);
  });

  it("unknown tool → error object, not a throw", async () => {
    const run = exec({});
    const out = (await run("no_such_tool", {})) as { error: string };
    expect(out.error).toMatch(/unknown tool/i);
  });
});
