import { describe, expect, it } from "vitest";
import { pickAgileStatus } from "../src/agile.js";

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
