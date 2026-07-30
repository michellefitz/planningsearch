import { describe, expect, it } from "vitest";
import { acpDecisionToStatus } from "../src/ingest/acp.js";

describe("acpDecisionToStatus", () => {
  it("treats progress notes and blanks as pending, not decisions", () => {
    expect(acpDecisionToStatus(null)).toBe("pending");
    expect(acpDecisionToStatus("")).toBe("pending");
    expect(acpDecisionToStatus("Case is due to be decided by 03/07/2024")).toBe("pending");
    expect(acpDecisionToStatus("Case is due to be decided by")).toBe("pending");
    expect(acpDecisionToStatus("Proposed Decision Date not available at this time")).toBe("pending");
    expect(acpDecisionToStatus("Consultations Closed")).toBe("pending");
    expect(acpDecisionToStatus("Further consideration needed for this case")).toBe("pending");
  });

  it("maps the board's grant/refuse phrasings", () => {
    expect(acpDecisionToStatus("Grant Perm. w   Conditions")).toBe("granted");
    expect(acpDecisionToStatus("Approve with Conditions")).toBe("granted");
    expect(acpDecisionToStatus("Application granted")).toBe("granted");
    expect(acpDecisionToStatus("Make Railway Order w   cons")).toBe("granted");
    expect(acpDecisionToStatus("Refuse Perm.")).toBe("refused");
    expect(acpDecisionToStatus("Refuse to Approve")).toBe("refused");
  });

  it("maps part grants and split decisions to split", () => {
    expect(acpDecisionToStatus("Grant Part Dev. w cons")).toBe("split");
    expect(acpDecisionToStatus("Split decision")).toBe("split");
  });

  it("maps withdrawal and invalidity", () => {
    expect(acpDecisionToStatus("Application withdrawn (applicant)")).toBe("withdrawn");
    expect(acpDecisionToStatus("Withdrawn")).toBe("withdrawn");
    expect(acpDecisionToStatus("Invalid Fee")).toBe("invalid");
  });

  it("maps quashed/annulled/altered decisions to decided (no operative outcome)", () => {
    expect(acpDecisionToStatus("Decision Quashed")).toBe("decided");
    expect(acpDecisionToStatus("Annulled")).toBe("decided");
    expect(acpDecisionToStatus("Please see case 305219 (Order 2)")).toBe("decided");
    expect(acpDecisionToStatus("Alter decision - Is a Material Alteration (No EIS)")).toBe("decided");
  });
});
