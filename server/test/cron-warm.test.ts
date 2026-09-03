import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The keep-warm ping.
 *
 * Cold, this function parses the whole register at module load before it can
 * answer anything — measured against production, the same search took 11.5s
 * cold and 0.44s warm. A cheap request every few minutes keeps an instance
 * alive so most real visitors arrive warm.
 */
vi.mock("../../api/_accounts/db.mjs", () => ({
  sql: async () => [],
  hasDb: () => true,
}));

const { handleAccountRoute, isAccountRoute } = await import("../../api/_accounts/routes.mjs");

function call(authorization?: string) {
  const req: Record<string, unknown> = {
    method: "GET",
    headers: authorization ? { authorization } : {},
    [Symbol.asyncIterator]: async function* () {},
  };
  const res = {
    statusCode: 0,
    body: null as unknown,
    setHeader() {},
    end(s: string) { this.body = JSON.parse(s); },
  };
  return handleAccountRoute(req, res, "/api/cron/warm", new URL("http://x/api/cron/warm"), {})
    .then(() => res);
}

beforeEach(() => {
  process.env.CRON_SECRET = "s3cret";
});

describe("/api/cron/warm", () => {
  it("is claimed by the account routes, or it would 404", () => {
    expect(isAccountRoute("/api/cron/warm")).toBe(true);
  });

  it("answers a correctly signed ping", async () => {
    const res = await call("Bearer s3cret");
    expect(res.statusCode).toBe(200);
    expect((res.body as { ok: boolean }).ok).toBe(true);
  });

  it("reports how long the instance has been up, so a ping that finds a cold process is visible", async () => {
    const body = (await call("Bearer s3cret")).body as { cold: boolean; uptime_ms: number };
    expect(typeof body.uptime_ms).toBe("number");
    expect(body.uptime_ms).toBeGreaterThanOrEqual(0);
    expect(typeof body.cold).toBe("boolean");
  });

  it("refuses an unsigned ping — it is a public URL", async () => {
    expect((await call()).statusCode).toBe(401);
  });

  it("refuses a wrong secret", async () => {
    expect((await call("Bearer nope-wrong-length-entirely")).statusCode).toBe(401);
  });

  it("refuses everything when no secret is configured", async () => {
    delete process.env.CRON_SECRET;
    expect((await call("Bearer s3cret")).statusCode).toBe(401);
  });
});
