import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The account's name field, and the guard that makes it reachable.
 *
 * GET and PATCH share the /api/me route, and the GET branch had no method
 * check — a PATCH fell straight into it and came back 200 with the account
 * unchanged, which looks exactly like a save that worked.
 */
const queries: Array<{ text: string; params: unknown[] }> = [];
let sessionUser: { id: number; email: string; name: string | null } | null = null;

vi.mock("../../api/_accounts/db.mjs", () => ({
  sql: async (text: string, params: unknown[] = []) => {
    queries.push({ text, params });
    if (/from sessions s join users u/.test(text)) return sessionUser ? [sessionUser] : [];
    if (/^update users set name/.test(text.trim())) return [];
    return [];
  },
  hasDb: () => true,
}));

const { handleAccountRoute } = await import("../../api/_accounts/routes.mjs");

function fakeReqRes(method: string, body: unknown) {
  const payload = body === undefined ? "" : JSON.stringify(body);
  const req: Record<string, unknown> = {
    method,
    headers: { cookie: "pv_session=tok" },
    [Symbol.asyncIterator]: async function* () {
      if (payload) yield Buffer.from(payload);
    },
  };
  const res = {
    statusCode: 0,
    headers: {} as Record<string, string>,
    body: null as unknown,
    setHeader(k: string, v: string) { this.headers[k] = v; },
    end(s: string) { this.body = JSON.parse(s); },
  };
  return { req, res };
}

const call = async (method: string, body?: unknown) => {
  const { req, res } = fakeReqRes(method, body);
  await handleAccountRoute(req, res, "/api/me", new URL("http://x/api/me"), {});
  return res;
};

beforeEach(() => {
  queries.length = 0;
  sessionUser = { id: 7, email: "a@b.ie", name: null };
});

describe("PATCH /api/me", () => {
  it("writes the name rather than falling into the GET branch", async () => {
    const res = await call("PATCH", { name: "Michelle" });
    const update = queries.find((q) => /update users set name/.test(q.text));
    expect(update, "no update was issued — the GET branch swallowed the PATCH").toBeTruthy();
    expect(update!.params).toEqual([7, "Michelle"]);
    expect((res.body as { user: { name: string } }).user.name).toBe("Michelle");
  });

  it("stores an emptied name as null, not an empty string", async () => {
    // So everything downstream has one "no name" to test for.
    await call("PATCH", { name: "   " });
    const update = queries.find((q) => /update users set name/.test(q.text));
    expect(update!.params[1]).toBeNull();
  });

  it("trims and caps the length", async () => {
    await call("PATCH", { name: "  " + "x".repeat(200) + "  " });
    const update = queries.find((q) => /update users set name/.test(q.text));
    expect((update!.params[1] as string).length).toBe(80);
  });

  it("refuses a body with nothing to update", async () => {
    const res = await call("PATCH", { nickname: "nope" });
    expect(res.statusCode).toBe(400);
    expect(queries.some((q) => /update users/.test(q.text))).toBe(false);
  });

  it("still answers GET with the account, name included", async () => {
    sessionUser = { id: 7, email: "a@b.ie", name: "Michelle" };
    const res = await call("GET");
    expect((res.body as { user: { email: string; name: string } }).user).toMatchObject({
      email: "a@b.ie",
      name: "Michelle",
    });
    expect(queries.some((q) => /update users/.test(q.text))).toBe(false);
  });

  it("needs a session", async () => {
    sessionUser = null;
    const res = await call("PATCH", { name: "Michelle" });
    expect(res.statusCode).toBe(401);
  });
});
