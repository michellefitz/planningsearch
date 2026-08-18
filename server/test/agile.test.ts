import { describe, expect, it } from "vitest";
import { pickAgileDecision, pickAgileStatus, pickSubmissionsBy } from "../src/agile.js";

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

/**
 * The one time-critical fact on an undecided application, and the national
 * dataset leaves the column empty for all four agile councils — so an
 * application still open for observations showed no deadline and no countdown.
 * Live values, read from the portals on 2026-08-18.
 */
describe("pickSubmissionsBy", () => {
  it("reads the date the portal prints as 'Due date to submit observations'", () => {
    // Dublin City WEBGSDZ2826/26 — the portal shows 26 Aug 2026.
    expect(
      pickSubmissionsBy({ publicityEndDate: "2026-08-26T00:00:00", submissionExpiryDate: null })
    ).toBe("2026-08-26");
  });

  it("prefers publicityEndDate, the only one every council fills in", () => {
    // Fingal and South Dublin carry both, always agreeing; Dublin City and DLR
    // carry publicityEndDate alone.
    expect(
      pickSubmissionsBy({ publicityEndDate: "2026-09-08T00:00:00", submissionExpiryDate: "2026-09-08T00:00:00" })
    ).toBe("2026-09-08");
    expect(pickSubmissionsBy({ publicityEndDate: "2026-09-10T00:00:00" })).toBe("2026-09-10");
  });

  it("falls back to submissionExpiryDate for a record that inverts it", () => {
    expect(
      pickSubmissionsBy({ publicityEndDate: null, submissionExpiryDate: "2026-07-20T00:00:00" })
    ).toBe("2026-07-20");
  });

  it("is null when neither is set, or when the value is not a date", () => {
    expect(pickSubmissionsBy({})).toBeNull();
    expect(pickSubmissionsBy({ publicityEndDate: null, submissionExpiryDate: null })).toBeNull();
    expect(pickSubmissionsBy({ publicityEndDate: "" })).toBeNull();
    expect(pickSubmissionsBy({ publicityEndDate: 20260826 })).toBeNull();
  });
});
