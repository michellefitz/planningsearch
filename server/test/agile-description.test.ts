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

  it("never returns the decision maker as the decision", () => {
    // Regression: a "…decision…" key holding the *maker* beat the outcome on
    // length ("Senior Planner West" is 19 chars, "GRANT PERMISSION" is 16), and
    // the alert emails read "Decision issued: Senior Planner West".
    const withMaker = { ...DLR, decisionMakerDescription: "Senior Planner West" };
    expect(pickAgileDecision(withMaker)).toBe("GRANT PERMISSION");
    const eastern = { ...DLR, decisionByPlanner: "Senior Planner East" };
    expect(pickAgileDecision(eastern)).toBe("GRANT PERMISSION");
  });

  it("returns null rather than a value with no outcome wording", () => {
    // Better no decision than a job title or a stage name presented as one.
    const { decisionText: _drop, ...noOutcome } = DLR;
    expect(pickAgileDecision({ ...noOutcome, decisionMakerDescription: "Senior Planner West" })).toBeNull();
  });

  it("still prefers the fuller wording of a split decision", () => {
    const split = { ...DLR, decisionText: "GRANT PERMISSION AND REFUSE PERMISSION" };
    expect(pickAgileDecision(split)).toBe("GRANT PERMISSION AND REFUSE PERMISSION");
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
