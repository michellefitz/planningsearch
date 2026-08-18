import { describe, expect, it } from "vitest";
import { decisionStage, normalizeStatus, realDecision } from "../src/normalize.js";
import {
  decisionStage as sharedStage,
  isFurtherInfoRequest,
  realDecision as sharedReal,
} from "../../api/_conditions/decision.mjs";

/**
 * Every distinct decision string seen in a sample of the live register
 * (200 rows per status, 2026-08-18), with the counts that made each one worth
 * handling. The first group is what the field says when nothing has been
 * decided; the second is what it says when something has.
 */
const STAGES = [
  ["N/A", "placeholder", 736],
  ["Request Additional Information", "further_info", 224],
  ["REQUEST ADDITIONAL INFORMATION", "further_info", 133],
  ["ADDITIONAL INFORMATION", "further_info", 124],
  ["REQUEST AI EXT OF TIME", "further_info", 22],
  ["S5 REQ AI", "further_info", 17],
  ["Seek Clarification of Additional Information", "further_info", 16],
  ["CLARIFICATION OF FURTHER INFORMATION", "further_info", 7],
  ["SEEK CLARIFICATION OF ADDITIONAL INFO.", "further_info", 6],
  ["CLARIFICATION OF ADDITIONAL INFORMATION", "further_info", 3],
  ["Request Further Particulars", "further_info", 1],
  ["REQUEST REVISED PUBLIC NOTICE", "procedural", 12],
  ["EXTENSION OF TIME", "procedural", 2],
  ["Request Time Extension", "procedural", 2],
  ["Request Revised Newspaper Notice", "procedural", 1],
  ["REVISED DRAWINGS ARTICLE 35", "procedural", 1],
] as const;

const OUTCOMES = [
  "GRANT PERMISSION",
  "REFUSE PERMISSION",
  "CONDITIONAL",
  "REFUSED",
  "SPLIT DECISION(PERMISSION & REFUSAL)",
  "GRANT PERMISSION & REFUSE PERMISSION",
  "APPLICATION DECLARED INVALID",
  "DECLARE APPLICATION INVALID",
  "Invalid Application",
  "WITHDRAW THE APPLICATION",
  "APPLICATION WITHDRAWN",
  "Declared Exempt",
  "Declared Not Exempt",
  "S5 DEC EXEMPT",
  "GRANT CERTIFICATE OF EXEMPTION",
  "REFUSE PERMISSION FOR RETENTION",
  // Unusual, but every one of these is a real thing that happened to the
  // application. Blanking them would delete the only record of the outcome.
  "Decision Quashed",
  "DECISION QUASHED BY HIGH COURT",
  "Annulled",
  "Cannot Determine",
  "CANNOT BE CONSIDERED",
  "Precluded under 34 (12)(b) from Making a Decision",
  "Returned Application under Section 37(5)",
  "Decision to be Made by Other Body",
  "Referred to An Coimisiún Pleanála for Determination",
];

describe("decisionStage", () => {
  it.each(STAGES)("reads %s as %s (%i rows in the register)", (text, stage) => {
    expect(decisionStage(text)).toBe(stage);
    expect(realDecision(text)).toBeNull();
  });

  it.each(OUTCOMES)("keeps %s — it names a real outcome", (text) => {
    expect(decisionStage(text)).toBeNull();
    expect(realDecision(text)).toBe(text);
  });

  it("keeps a decision that mentions both, since the outcome is what happened", () => {
    // "Grant permission following receipt of additional information" is a
    // grant, not a request — the outcome test runs first for exactly this.
    const both = "GRANT PERMISSION FOLLOWING RECEIPT OF ADDITIONAL INFORMATION";
    expect(decisionStage(both)).toBeNull();
    expect(realDecision(both)).toBe(both);
  });

  it("passes a blank field straight through", () => {
    expect(decisionStage(null)).toBeNull();
    expect(decisionStage("")).toBeNull();
    expect(realDecision(null)).toBeNull();
    expect(realDecision(undefined)).toBeNull();
  });

  /**
   * The rules live twice — in normalize.ts for ingestion, and in
   * api/_conditions/decision.mjs for the browser and the serverless API, which
   * cannot import from the server's build. Nothing stops the two drifting
   * except this.
   */
  it("agrees with the copy the browser and the API use", () => {
    for (const [text] of STAGES) {
      expect(sharedStage(text)).toBe(decisionStage(text));
      expect(sharedReal(text)).toBe(realDecision(text));
    }
    for (const text of OUTCOMES) {
      expect(sharedStage(text)).toBe(decisionStage(text));
      expect(sharedReal(text)).toBe(realDecision(text));
    }
    expect(isFurtherInfoRequest("Request Additional Information")).toBe(true);
    expect(isFurtherInfoRequest("N/A")).toBe(false);
    expect(isFurtherInfoRequest("GRANT PERMISSION")).toBe(false);
  });
});

describe("normalizeStatus reads a request for information as a stage", () => {
  // Real pairings, with the number of rows each accounted for in the sample.
  it.each([
    ["Decision Notice Issued", "ADDITIONAL INFORMATION", 83],
    ["Decision Issued", "REQUEST ADDITIONAL INFORMATION", 38],
    ["AI Requested", "Request Additional Information", 22],
    ["Clarification of AI Requested", "SEEK CLARIFICATION OF ADDITIONAL INFO.", 5],
    ["Decision Issued", "CLARIFICATION OF FURTHER INFORMATION", 3],
  ])("%s + %s → further_info (was unknown, %i rows)", (raw, decision) => {
    expect(normalizeStatus(raw, decision)).toBe("further_info");
  });

  it("never lets the stage override a real outcome or a terminal status", () => {
    // The council asked for information, got it, and then decided.
    expect(normalizeStatus("Decision Notice Issued", "GRANT PERMISSION")).toBe("granted");
    expect(normalizeStatus("APPLICATION WITHDRAWN", "ADDITIONAL INFORMATION")).toBe("withdrawn");
    expect(normalizeStatus("Invalid Application", "Request Additional Information")).toBe("invalid");
  });

  it("leaves a placeholder decision to the status text", () => {
    // "N/A" says nothing at all, so it must not push a status anywhere.
    expect(normalizeStatus("PUBLICATION REQUIRED", "N/A")).toBe("unknown");
    expect(normalizeStatus("WITHDRAWN", "N/A")).toBe("withdrawn");
    expect(normalizeStatus("NEW APPLICATION", "N/A")).toBe("pending");
  });
});
