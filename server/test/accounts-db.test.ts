import { afterEach, describe, expect, it, vi } from "vitest";
import { sql } from "../../api/_accounts/db.mjs";

const CS = "postgresql://user:pass@ep-test-123.eu-west-1.aws.neon.tech/neondb";

describe("sql", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.DATABASE_URL;
  });

  it("throws without DATABASE_URL", async () => {
    await expect(sql("select 1")).rejects.toThrow("DATABASE_URL not set");
  });

  it("POSTs query+params to the Neon host with the connection string header", async () => {
    process.env.DATABASE_URL = CS;
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({ rows: [{ n: 1 }] }),
    }));
    vi.stubGlobal("fetch", fetchMock);
    const rows = await sql("select $1::int as n", [1]);
    expect(rows).toEqual([{ n: 1 }]);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://ep-test-123.eu-west-1.aws.neon.tech/sql");
    expect(init.method).toBe("POST");
    expect(init.headers["Neon-Connection-String"]).toBe(CS);
    expect(JSON.parse(init.body)).toEqual({ query: "select $1::int as n", params: [1] });
  });

  it("throws with status detail on non-OK response", async () => {
    process.env.DATABASE_URL = CS;
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: false, status: 400, text: async () => "syntax error",
    })));
    await expect(sql("bogus")).rejects.toThrow("neon: HTTP 400");
  });
});
