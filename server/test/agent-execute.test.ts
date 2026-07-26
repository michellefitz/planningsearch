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

  it("read_appeal_document fetches the matching case PDF and answers the question", async () => {
    const appealRow = { ...ROW, id: 44, appeal_reference: "ABP-319506-26" };
    const db = { prepare: () => ({ get: (id: number) => (id === 44 ? appealRow : undefined) }) } as never;
    const run = buildToolExecutor(db, {
      fetchAppealCase: async () => ({
        fields: [],
        documents: [
          { title: "Board Order", url: "https://abp.example/order.pdf" },
          { title: "Inspector's Report", url: "https://abp.example/inspector.pdf" },
        ],
      }),
      fetchAppealDocumentBase64: async (url: string) => {
        expect(url).toBe("https://abp.example/inspector.pdf");
        return "cGRm";
      },
      readDocumentWithClaude: async (_pdf: string, context: string, question?: string) => {
        expect(context).toContain("ABP-319506-26");
        expect(question).toBe("What did the inspector recommend?");
        return "The inspector recommended a grant subject to a reduced dormer.";
      },
    } as never);
    const out = (await run("read_appeal_document", {
      application_id: 44,
      document: "inspector",
      question: "What did the inspector recommend?",
    })) as { document: string; answer: string; other_documents: string[] };
    expect(out.document).toBe("Inspector's Report");
    expect(out.answer).toMatch(/reduced dormer/);
    expect(out.other_documents).toEqual(["Board Order"]);
  });

  it("read_appeal_document errors with the available titles when nothing matches", async () => {
    const appealRow = { ...ROW, id: 44, appeal_reference: "ABP-319506-26" };
    const db = { prepare: () => ({ get: (id: number) => (id === 44 ? appealRow : undefined) }) } as never;
    const run = buildToolExecutor(db, {
      fetchAppealCase: async () => ({
        fields: [],
        documents: [{ title: "Board Order", url: "https://abp.example/order.pdf" }],
      }),
    } as never);
    const out = (await run("read_appeal_document", {
      application_id: 44,
      document: "environmental impact statement",
    })) as { error: string; available: string[] };
    expect(out.error).toMatch(/matches/i);
    expect(out.available).toEqual(["Board Order"]);
  });

  it("read_document reads an Agile council PDF by title words", async () => {
    const fingalRow = { ...ROW, id: 43, authority_id: "fingal", planning_reference: "F23/456", source_url: null };
    const db = { prepare: () => ({ get: (id: number) => (id === 43 ? fingalRow : undefined) }) } as never;
    const run = buildToolExecutor(db, {
      fetchAgileDocumentList: async () => ({
        files: [{ title: "Site Plan", url: "x" }, { title: "Planner's Report — 12/03/2023", url: "y" }],
        applicationUrl: "https://example.com/app/1",
      }),
      fetchAgileDocument: async (_a: string, _s: null, _r: string, index: number) => {
        expect(index).toBe(1);
        return { contentType: "application/pdf", filename: "report.pdf", body: Buffer.from("pdf") };
      },
      readDocumentWithClaude: async () => "The planner recommended permission with conditions.",
    } as never);
    const out = (await run("read_document", {
      application_id: 43,
      title: "planner report",
      question: "What did the planner recommend?",
    })) as { document: string; answer: string };
    expect(out.document).toBe("Planner's Report — 12/03/2023");
    expect(out.answer).toMatch(/recommended permission/);
  });

  it("read_document refuses non-PDF documents plainly", async () => {
    const fingalRow = { ...ROW, id: 43, authority_id: "fingal", planning_reference: "F23/456", source_url: null };
    const db = { prepare: () => ({ get: (id: number) => (id === 43 ? fingalRow : undefined) }) } as never;
    const run = buildToolExecutor(db, {
      fetchAgileDocumentList: async () => ({
        files: [{ title: "Site Plan", url: "x" }],
        applicationUrl: "https://example.com/app/1",
      }),
      fetchAgileDocument: async () => ({ contentType: "image/tiff", filename: "plan.tif", body: Buffer.from("x") }),
    } as never);
    const out = (await run("read_document", { application_id: 43, title: "site plan" })) as { error: string };
    expect(out.error).toMatch(/not a PDF/i);
  });
});
