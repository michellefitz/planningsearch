import { describe, expect, it } from "vitest";
import Fastify from "fastify";
import { registerRoutes } from "../src/api.js";

// The pipeline itself is covered in preplan-report.test.ts; here we check the
// route's contract — validation before any streaming starts.
async function app() {
  const f = Fastify({ logger: false });
  registerRoutes(f, { prepare: () => ({ get: () => undefined, all: () => [] }) } as never);
  return f;
}

describe("POST /api/preplan/generate", () => {
  it("400s without coordinates or intent", async () => {
    const f = await app();
    for (const payload of [{}, { lat: 53.3, lng: -6.5 }, { lat: "x", lng: -6.5, intent: "shed" }]) {
      const res = await f.inject({ method: "POST", url: "/api/preplan/generate", payload });
      expect(res.statusCode).toBe(400);
    }
    await f.close();
  });

  it("streams SSE events and ends with done for a valid request", async () => {
    const f = await app();
    const res = await f.inject({
      method: "POST",
      url: "/api/preplan/generate",
      payload: { lat: 53.3813, lng: -6.5918, address: "Maynooth", intent: "rear extension" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/event-stream");
    const events = res.body
      .split("\n\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l.replace(/^data: /, "")));
    expect(events[0].type).toBe("progress");
    expect(events[events.length - 1].type).toBe("done");
  });
});
