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

// Real DLR payload (D22A/0364) supplied 2026-07-27 — the tenant's actual keys.
import { pickAgileDecision, pickAgileStatus, pickOfficer } from "../src/agile.js";

const DLR = {
  reference: "D22A/0364",
  proposal: "Permission for development. The development will consist of",
  fullProposal:
    "Permission for development. The development will consist of the construction of a ground floor extension (40m2) at the rear of the property and alterations to the front elevation, widening of existing vehicular entrance and provision of new gate to front including all associated site works to existing two storey semi-detached dwelling.",
  decisionText: "GRANT PERMISSION",
  decisionDate: "2022-09-19T00:00:00",
  statusDescription: "Decision made",
  statusDescriptionOwner: "Decision made",
  statusDescriptionNonOwner: "Decision made",
  applicationType: "Permission",
  levelOfDecisionCode: "AO",
  levelOfDecisionDescription: "Approved Officer",
  developmentCategory: "",
};

describe("DLR payload (real tenant keys)", () => {
  it("description = fullProposal, not the truncated proposal", () => {
    expect(pickDescription(DLR)).toBe(DLR.fullProposal);
  });

  it("decision = decisionText, never the level-of-decision fields", () => {
    expect(pickAgileDecision(DLR)).toBe("GRANT PERMISSION");
    // A short refusal must not lose to "Approved Officer" (who decided ≠ outcome).
    expect(pickAgileDecision({ ...DLR, decisionText: "REFUSED" })).toBe("REFUSED");
  });

  it("status = the stage description", () => {
    expect(pickAgileStatus(DLR)).toBe("Decision made");
  });
});

describe("pickOfficer", () => {
  it("finds the case officer, skipping contact fields (DLR payload)", () => {
    expect(
      pickOfficer({ officerName: "Oliver Reid", officerTelephone: "", officerEmail: "oreid@DLRCOCO.IE" })
    ).toBe("Oliver Reid");
    expect(pickOfficer({ officerEmail: "x@y.ie" })).toBeNull();
  });
});
