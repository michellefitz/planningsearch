import { describe, expect, it } from "vitest";
import {
  clearSessionCookie,
  parseCookies,
  randomToken,
  SESSION_COOKIE,
  sessionCookie,
  sha256Hex,
} from "../../api/accounts/tokens.mjs";

describe("tokens", () => {
  it("randomToken is 64 hex chars and unique", () => {
    const a = randomToken();
    const b = randomToken();
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(a).not.toBe(b);
  });

  it("sha256Hex matches a known vector", () => {
    expect(sha256Hex("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
    );
  });

  it("parseCookies handles absent, single and multiple cookies", () => {
    expect(parseCookies(undefined)).toEqual({});
    expect(parseCookies("pv_session=abc123")).toEqual({ pv_session: "abc123" });
    expect(parseCookies("a=1; pv_session=xyz; b=2")).toEqual({ a: "1", pv_session: "xyz", b: "2" });
  });

  it("sessionCookie sets the hardened attributes", () => {
    const c = sessionCookie("tok");
    expect(c).toContain(`${SESSION_COOKIE}=tok`);
    expect(c).toContain("HttpOnly");
    expect(c).toContain("Secure");
    expect(c).toContain("SameSite=Lax");
    expect(c).toContain("Path=/");
    expect(c).toContain(`Max-Age=${90 * 86400}`);
  });

  it("clearSessionCookie zeroes Max-Age", () => {
    expect(clearSessionCookie()).toContain("Max-Age=0");
  });
});
