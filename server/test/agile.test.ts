import { describe, expect, it } from "vitest";
import { pickAgileDecision, pickAgileStatus } from "../src/agile.js";

describe("pickAgileStatus", () => {
  it("prefers the human status description over a short code, ignoring appeal/date fields", () => {
    expect(
      pickAgileStatus({
        applicationStatus: "INV",
        applicationStatusDescription: "Invalid",
        appealStatusDescription: "No appeal lodged",
        statusChangedDate: "2026-05-01T00:00:00",
      })
    ).toBe("Invalid");
  });

  it("returns null when no status-bearing field is present", () => {
    expect(
      pickAgileStatus({ applicantSurname: "Ryan", proposalDescription: "extension" })
    ).toBeNull();
  });

  it("skips date-like status values", () => {
    expect(pickAgileStatus({ statusInfo: "2026-01-02T09:00:00" })).toBeNull();
  });
});

describe("pickAgileDecision", () => {
  it("reads the outcome from a decision field, distinct from the status stage", () => {
    expect(
      pickAgileDecision({
        applicationStatusDescription: "Decision Notice Issued",
        decisionDescription: "Application Declared Invalid",
        decisionDate: "2023-02-14T00:00:00",
        appealDecision: "None",
      })
    ).toBe("Application Declared Invalid");
  });

  it("returns null when no decision field is present", () => {
    expect(pickAgileDecision({ applicationStatus: "Decision Notice Issued" })).toBeNull();
  });
});
