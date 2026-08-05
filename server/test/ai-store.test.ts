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
