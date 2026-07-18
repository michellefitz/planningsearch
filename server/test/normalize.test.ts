import { describe, expect, it } from "vitest";
import {
  guessIsDomestic,
  normalizeApplicationType,
  normalizeStatus,
} from "../src/normalize.js";

describe("normalizeStatus", () => {
  it("maps vendor labels onto canonical statuses", () => {
    expect(normalizeStatus("New Application")).toBe("pending");
    expect(normalizeStatus("Further Information Requested")).toBe("further_info");
    expect(normalizeStatus("Decision Made", "Grant Permission")).toBe("granted");
    expect(normalizeStatus("REFUSED")).toBe("refused");
    expect(normalizeStatus("Application Withdrawn")).toBe("withdrawn");
    expect(normalizeStatus("Invalid Application")).toBe("invalid");
    expect(normalizeStatus("Appealed to An Bord Pleanala")).toBe("appealed");
  });

  it("falls back to the decision text when status is blank", () => {
    expect(normalizeStatus(null, "Refuse Permission")).toBe("refused");
    expect(normalizeStatus("", "Grant Permission")).toBe("granted");
  });

  it("never guesses on unrecognised labels", () => {
    expect(normalizeStatus("Something Novel")).toBe("unknown");
    expect(normalizeStatus(null, null)).toBe("pending");
  });
});

describe("normalizeApplicationType", () => {
  it("maps common labels", () => {
    expect(normalizeApplicationType("Permission")).toBe("permission");
    expect(normalizeApplicationType("Retention Permission")).toBe("retention");
    expect(normalizeApplicationType("Outline Permission")).toBe("outline");
    expect(normalizeApplicationType("Extension of Duration")).toBe("extension_of_duration");
    expect(normalizeApplicationType("weird")).toBe("other");
  });
});

describe("guessIsDomestic", () => {
  it("flags typical domestic descriptions", () => {
    expect(
      guessIsDomestic("Construction of a single storey extension to the rear of the existing dwelling")
    ).toBe(true);
    expect(guessIsDomestic("Attic conversion with dormer window to the rear")).toBe(true);
  });

  it("rejects clearly non-domestic descriptions", () => {
    expect(
      guessIsDomestic("Construction of 48 no. residential units (24 houses, 24 apartments), a creche")
    ).toBe(false);
    expect(guessIsDomestic("Erection of an agricultural shed with slatted tank")).toBe(false);
  });

  it("handles empty input", () => {
    expect(guessIsDomestic(null)).toBe(false);
  });
});
