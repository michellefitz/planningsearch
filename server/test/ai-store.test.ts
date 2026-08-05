import { beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  AI_CACHE_KINDS,
  _resetAiCacheMemo,
  aiCacheGet,
  aiCachePut,
  aiCached,
} from "../../api/_ai/store.mjs";
import { descriptionKey, descriptionUserMsg } from "../../api/_ai/descriptions.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

beforeEach(() => {
  _resetAiCacheMemo();
  delete process.env.DATABASE_URL;
});

describe("aiCached", () => {
  it("generates on a miss and serves the memo on the next call", async () => {
    let calls = 0;
    const gen = async () => {
      calls++;
      return { summary: "x" };
    };
    const a = await aiCached(AI_CACHE_KINDS.REFUSAL, "dlr", "D26A/0070/WEB", gen);
    const b = await aiCached(AI_CACHE_KINDS.REFUSAL, "dlr", "D26A/0070/WEB", gen);
    expect(a).toEqual({ summary: "x" });
    expect(b).toEqual({ summary: "x" });
    expect(calls).toBe(1);
  });

  it("stores an empty result — 'nothing binds you' is a real answer", async () => {
    let calls = 0;
    const gen = async () => {
      calls++;
      return [];
    };
    await aiCached(AI_CACHE_KINDS.HIGHLIGHTS, "dlr", "X/1", gen);
    await aiCached(AI_CACHE_KINDS.HIGHLIGHTS, "dlr", "X/1", gen);
    expect(calls).toBe(1);
  });

  it("does NOT store a failure, so a timeout retries next view", async () => {
    let calls = 0;
    const gen = async () => {
      calls++;
      return null;
    };
    expect(await aiCached(AI_CACHE_KINDS.HIGHLIGHTS, "dlr", "Y/1", gen)).toBeNull();
    expect(await aiCached(AI_CACHE_KINDS.HIGHLIGHTS, "dlr", "Y/1", gen)).toBeNull();
    expect(calls).toBe(2);
  });

  it("keeps kinds apart for the same application", async () => {
    await aiCachePut(AI_CACHE_KINDS.REFUSAL, "dlr", "Z/1", "refusal text");
    expect(await aiCacheGet(AI_CACHE_KINDS.HIGHLIGHTS, "dlr", "Z/1")).toBeUndefined();
    expect(await aiCacheGet(AI_CACHE_KINDS.REFUSAL, "dlr", "Z/1")).toBe("refusal text");
  });

  it("keeps the same reference apart across councils", async () => {
    await aiCachePut(AI_CACHE_KINDS.REFUSAL, "fingal", "F26A/0001", "fingal");
    expect(await aiCacheGet(AI_CACHE_KINDS.REFUSAL, "dlr", "F26A/0001")).toBeUndefined();
  });

  it("is a no-op, never a throw, with no database configured", async () => {
    await expect(aiCachePut(AI_CACHE_KINDS.APPEAL, "dlr", "N/1", { a: 1 })).resolves.toBeUndefined();
    _resetAiCacheMemo();
    expect(await aiCacheGet(AI_CACHE_KINDS.APPEAL, "dlr", "N/1")).toBeUndefined();
  });

  it("ignores a row with no identity rather than colliding on empty keys", async () => {
    await aiCachePut(AI_CACHE_KINDS.REFUSAL, "", "", "junk");
    expect(await aiCacheGet(AI_CACHE_KINDS.REFUSAL, "", "")).toBeUndefined();
  });
});

describe("descriptionKey", () => {
  it("gives the same key to the same wording", () => {
    expect(descriptionKey("Two-storey rear extension")).toBe(
      descriptionKey("Two-storey rear extension")
    );
  });

  it("ignores reflowed whitespace, which the registers vary freely", () => {
    expect(descriptionKey("Two-storey  rear\n extension ")).toBe(
      descriptionKey("Two-storey rear extension")
    );
  });

  it("changes when the description changes, so a fuller text is re-summarised", () => {
    // The nightly agile harvest replaces truncated national text with the
    // council's full wording — the old summary must not be reused for it.
    expect(descriptionKey("Two-storey rear extension")).not.toBe(
      descriptionKey("Two-storey rear extension and attic conversion")
    );
  });

  it("has no key for an empty description", () => {
    expect(descriptionKey("")).toBeNull();
    expect(descriptionKey("   ")).toBeNull();
    expect(descriptionKey(null)).toBeNull();
  });

  it("is short enough to key 122k rows without bloating the sidecar", () => {
    expect(descriptionKey("anything")).toHaveLength(24);
  });
});

describe("descriptionUserMsg", () => {
  it("passes the application type through, which helps the model classify", () => {
    expect(descriptionUserMsg("A shed", "permission")).toContain("Application type: permission");
  });
  it("sends the description alone when the type is unknown", () => {
    expect(descriptionUserMsg("A shed", null)).toBe("A shed");
  });
});

describe("versionedKind", () => {
  it("changes when the prompt changes, so a fix reaches cached applications", async () => {
    const { versionedKind, AI_CACHE_KINDS } = await import("../../api/_ai/store.mjs");
    const a = versionedKind(AI_CACHE_KINDS.HIGHLIGHTS, "prompt one");
    const b = versionedKind(AI_CACHE_KINDS.HIGHLIGHTS, "prompt two");
    expect(a).not.toBe(b);
    expect(versionedKind(AI_CACHE_KINDS.HIGHLIGHTS, "prompt one")).toBe(a);
  });

  it("keeps the kind readable, so a row can be traced back", async () => {
    const { versionedKind } = await import("../../api/_ai/store.mjs");
    expect(versionedKind("condition_highlights", "x")).toMatch(/^condition_highlights@[0-9a-f]{8}$/);
  });

  it("is wired to the live prompt in the serverless entry", () => {
    // Without this the durable cache would pin every application to whatever
    // prompt happened to be deployed when it was first viewed.
    const entry = fs.readFileSync(path.join(ROOT, "api/_index.mjs"), "utf8");
    expect(entry).toMatch(/versionedKind\(\s*[\s\S]{0,200}?AI_CACHE_KINDS\.HIGHLIGHTS,\s*HIGHLIGHTS_PROMPT/);
  });
});

describe("topUpDescriptionSummaries", () => {
  it("does nothing, and says why, without the credentials it needs", async () => {
    const { topUpDescriptionSummaries } = await import("../../api/_ai/topup.mjs");
    delete process.env.ANTHROPIC_API_KEY;
    expect(await topUpDescriptionSummaries([{ description: "a shed" }])).toEqual({
      skipped: "ANTHROPIC_API_KEY not set",
    });
    process.env.ANTHROPIC_API_KEY = "test-key";
    expect(await topUpDescriptionSummaries([{ description: "a shed" }])).toEqual({
      skipped: "DATABASE_URL not set",
    });
    delete process.env.ANTHROPIC_API_KEY;
  });

  it("runs inside the cron's budget, which the agile harvest also draws on", async () => {
    const src = fs.readFileSync(path.join(ROOT, "api/_ai/topup.mjs"), "utf8");
    const budget = Number(src.match(/TIME_BUDGET_MS = ([\d_]+)/)?.[1].replace(/_/g, ""));
    const harvest = fs.readFileSync(path.join(ROOT, "api/_accounts/harvest.mjs"), "utf8");
    const harvestBudget = Number(harvest.match(/TIME_BUDGET_MS = ([\d_]+)/)?.[1].replace(/_/g, ""));
    // maxDuration is 300 s (scripts/build-vercel.mjs) and both run in the same
    // request, ahead of the deploy hook.
    expect(budget + harvestBudget).toBeLessThan(300_000);
  });
});

describe("the upload script's batch insert", () => {
  it("numbers placeholders across rows, so row 2 doesn't overwrite row 1", async () => {
    const { insertStatement } = await import("../../scripts/summaries/upload.mjs");
    const { query, params } = insertStatement([
      { h: "aaa", s: "first" },
      { h: "bbb", s: "second" },
    ]);
    expect(query).toContain("($1, $2, $3),($4, $5, $6)");
    expect(params).toEqual([
      "aaa", "first", "claude-haiku-4-5-20251001",
      "bbb", "second", "claude-haiku-4-5-20251001",
    ]);
  });

  it("leaves an existing summary alone, so a rerun is a no-op", async () => {
    const { insertStatement } = await import("../../scripts/summaries/upload.mjs");
    expect(insertStatement([{ h: "a", s: "b" }]).query).toContain("do nothing");
  });

  it("survives the torn last line an interrupted run leaves behind", async () => {
    const { readSummaries } = await import("../../scripts/summaries/upload.mjs");
    const rows = readSummaries(
      '{"h":"a","s":"one"}\n{"h":"b","s":"two"}\n{"h":"c","s":"th'
    );
    expect(rows.map((r: { h: string }) => r.h)).toEqual(["a", "b"]);
  });

  it("de-duplicates a hash a resumed run appended twice", async () => {
    const { readSummaries } = await import("../../scripts/summaries/upload.mjs");
    expect(readSummaries('{"h":"a","s":"one"}\n{"h":"a","s":"one"}')).toHaveLength(1);
  });
});

describe("the Vercel function bundle", () => {
  // A missing directory here is not a build error — it is a runtime crash on
  // the first request that touches it, in production only.
  it("copies every api/ directory that _index.mjs imports from", () => {
    const entry = fs.readFileSync(path.join(ROOT, "api/_index.mjs"), "utf8");
    const imported = new Set(
      [...entry.matchAll(/from\s+"\.\/(_[a-z]+)\//g)].map((m) => m[1])
    );
    expect(imported.size).toBeGreaterThan(0);
    const build = fs.readFileSync(path.join(ROOT, "scripts/build-vercel.mjs"), "utf8");
    for (const dir of imported) expect(build).toContain(`"${dir}"`);
  });

  it("leaves the backfill's working file out of the function", () => {
    const build = fs.readFileSync(path.join(ROOT, "scripts/build-vercel.mjs"), "utf8");
    expect(build).toContain(".jsonl");
  });
});
