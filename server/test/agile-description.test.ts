import { describe, expect, it } from "vitest";
import { pickDescription } from "../src/agile.js";

describe("pickDescription", () => {
  it("prefers the longest proposal-ish field", () => {
    expect(
      pickDescription({ proposal: "short", fullProposal: "a much longer full proposal text" })
    ).toBe("a much longer full proposal text");
  });

  it("never picks status/decision narratives, even when longer (Fingal FW25A/0194)", () => {
    expect(
      pickDescription({
        proposal: "New play area and low fence in the 3 existing courtyards.",
        statusDescriptionOwner:
          "On 24 Jun 2025, a decision REFUSE PERMISSION was made by Fingal County Council on this application. " +
          "Subsequently, an appeal was lodged on 21 Jul 2025 and a decision to Refuse Permission was made by An Bord Pleanala on 30 Oct 2025.",
        levelOfDecisionDescription: "Delegated decision description that is quite long as well indeed",
      })
    ).toBe("New play area and low fence in the 3 existing courtyards.");
  });

  it("null when only status-ish keys exist", () => {
    expect(pickDescription({ statusDescription: "Decided", decisionText: "Refused" })).toBeNull();
  });
});
