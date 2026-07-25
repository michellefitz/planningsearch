import { describe, expect, it } from "vitest";
import { isAccountRoute } from "../../api/accounts/routes.mjs";

describe("isAccountRoute", () => {
  it.each([
    "/api/auth/request-link", "/api/auth/verify", "/api/auth/logout",
    "/api/me", "/api/saves", "/api/saves/12", "/api/lists",
    "/api/lists/3/items", "/api/resolve", "/api/cron/check-updates",
  ])("claims %s", (r) => expect(isAccountRoute(r)).toBe(true));

  it.each(["/api/meta", "/api/search", "/api/agent", "/api/applications/1"])(
    "ignores %s", (r) => expect(isAccountRoute(r)).toBe(false));
});
