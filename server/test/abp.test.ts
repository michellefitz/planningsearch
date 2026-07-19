import { describe, expect, it } from "vitest";
import { abpCaseNumber, abpCaseUrl } from "../src/abp.js";

describe("abpCaseNumber", () => {
  it("extracts the six-digit case number from every reference form", () => {
    expect(abpCaseNumber("ABP-319506-23")).toBe("319506");
    expect(abpCaseNumber("ACP-301000-21")).toBe("301000");
    expect(abpCaseNumber("PL29N.301702")).toBe("301702");
    expect(abpCaseNumber("TR17.310928")).toBe("310928");
    expect(abpCaseNumber("319506")).toBe("319506");
  });

  it("returns null when there is no six-digit group", () => {
    expect(abpCaseNumber("")).toBeNull();
    expect(abpCaseNumber(null)).toBeNull();
    expect(abpCaseNumber(undefined)).toBeNull();
    expect(abpCaseNumber("ABP-1234-05")).toBeNull();
  });
});

describe("abpCaseUrl", () => {
  it("builds a case-file deep link", () => {
    expect(abpCaseUrl("ABP-319506-23")).toBe(
      "https://www.pleanala.ie/en-ie/case/319506"
    );
    expect(abpCaseUrl("PL29N.301702")).toBe(
      "https://www.pleanala.ie/en-ie/case/301702"
    );
  });

  it("returns null for unparseable or missing references", () => {
    expect(abpCaseUrl(null)).toBeNull();
    expect(abpCaseUrl("no digits here")).toBeNull();
  });
});
