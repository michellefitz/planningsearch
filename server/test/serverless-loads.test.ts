import { describe, expect, it } from "vitest";

/**
 * The Vercel serverless entry (api/_index.mjs) is a hand-written mirror of the
 * server logic, so ordering bugs (e.g. a const used before its declaration)
 * aren't caught by the server's TypeScript build or by `node --check` — they
 * only surface as a module-load crash that 500s every route in production.
 * This guards against that: importing the module must not throw.
 */
describe("serverless entry (api/_index.mjs)", () => {
  it("loads without throwing and exports a handler", async () => {
    const mod = await import("../../api/_index.mjs");
    expect(typeof mod.default).toBe("function");
  });
});
