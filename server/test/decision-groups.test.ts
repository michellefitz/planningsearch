import { describe, expect, it } from "vitest";
// The helpers live with the UI that renders them; the suite lives here.
import {
  bcmsNoticeUrl,
  conditionGroups,
  DECISION_CODES,
  FURTHER_INFO_CODES,
  isRefusalDecision,
  sectionCodes,
} from "../../web/src/components/DetailPanel.js";

describe("isRefusalDecision", () => {
  it("does not read a grant as a refusal", () => {
    // The bug this guards: DLR D26A/0070/WEB is "GRANT PERMISSION" and carries
    // a code-"R" First Schedule, which used to render as "Reasons for refusal".
    expect(isRefusalDecision("GRANT PERMISSION")).toBe(false);
    expect(isRefusalDecision("GRANT PERMISSION FOR RETENTION")).toBe(false);
    expect(isRefusalDecision("CONDITIONAL PERMISSION")).toBe(false);
  });

  it("catches refusals however the register words them", () => {
    expect(isRefusalDecision("REFUSE PERMISSION")).toBe(true);
    expect(isRefusalDecision("Refused")).toBe(true);
    expect(isRefusalDecision("refusal of permission for retention")).toBe(true);
  });

  it("treats a split decision as a refusal, since real grounds are given", () => {
    expect(isRefusalDecision("GRANT PERMISSION FOR RETENTION AND REFUSE PERMISSION")).toBe(true);
  });

  it("is false for a decision that has not been recorded", () => {
    expect(isRefusalDecision(null)).toBe(false);
    expect(isRefusalDecision(undefined)).toBe(false);
    expect(isRefusalDecision("")).toBe(false);
  });
});

describe("bcmsNoticeUrl", () => {
  it("uses the dataset slug that exists — /dataset/bcms 404s", () => {
    const url = bcmsNoticeUrl("CN0143257DR");
    expect(url).toContain("/dataset/bcnccc/resource/");
    expect(url).not.toContain("/dataset/bcms/");
  });

  it("filters on CN_Number, which the portal honours, not q, which it ignores", () => {
    expect(bcmsNoticeUrl("CN0143257DR")).toBe(
      "https://data.nbco.gov.ie/dataset/bcnccc/resource/0774e781-7af8-46da-b623-872e74cf541e" +
        "?filters=CN_Number%3ACN0143257DR"
    );
  });

  it("points at the same resource the ingest reads, so the row is really there", async () => {
    const { BCMS_RESOURCE_ID } = await import("../src/ingest/bcms.js");
    expect(bcmsNoticeUrl("CN0143257DR")).toContain(BCMS_RESOURCE_ID);
  });
});

describe("which section owns which prescription code", () => {
  // The bug: Dublin City PWSDZ3074/23 is a grant with sixteen conditions and
  // no further-information items at all — its "Further information" section
  // exists only because the register carries a requested date. Both sections
  // were handed the whole conditions payload, so all sixteen binding
  // conditions rendered under "Further information", headed "Conditions of
  // this decision".
  const CODES = conditionGroups(null).map((g) => g.code);

  it("gives every code exactly one home", () => {
    const owned = [...FURTHER_INFO_CODES, ...DECISION_CODES];
    expect([...owned].sort()).toEqual([...CODES].sort());
    expect(new Set(owned).size).toBe(owned.length);
  });

  it("keeps the decision's own conditions out of the further-information section", () => {
    expect(FURTHER_INFO_CODES).not.toContain("C");
    expect(FURTHER_INFO_CODES).not.toContain("R");
    expect(FURTHER_INFO_CODES).not.toContain("N");
  });

  it("renders nothing under further information for a conditions-only payload", () => {
    const items = Array.from({ length: 16 }, (_, i) => ({ code: "C", order: i + 1 }));
    const shown = conditionGroups(null)
      .filter((g) => FURTHER_INFO_CODES.includes(g.code as "D"))
      .filter((g) => items.some((i) => i.code === g.code));
    expect(shown).toEqual([]);
  });

  it("still shows the request where the council actually filed one", () => {
    const items = [{ code: "D", order: 1 }, { code: "C", order: 1 }];
    const shown = conditionGroups(null)
      .filter((g) => FURTHER_INFO_CODES.includes(g.code as "D"))
      .filter((g) => items.some((i) => i.code === g.code));
    expect(shown.map((g) => g.code)).toEqual(["D"]);
  });

  it("leaves the request out of the decision section", () => {
    expect(DECISION_CODES).not.toContain("D");
    // "I" and "N" stay with the decision: Dublin City files the two halves of
    // a split decision as an Informative and a Note.
    expect(DECISION_CODES).toContain("I");
    expect(DECISION_CODES).toContain("N");
  });
});

describe("who owns the Informative items", () => {
  /**
   * The councils do not agree on what "I" means, so it cannot be routed by
   * code. Sampled the 40 most recent DLR applications that went out for
   * further information: 20 carry an "I" item, only 1 carries a "D", and all
   * 20 of those "I" texts are the request itself — "The applicant is
   * requested to submit revised proposals which address these concerns"
   * (D20A/0569), "RECOMMENDATION … request the following FURTHER INFORMATION"
   * (D26A/0318/WEB). The same sample on Dublin City found no "I" items at all
   * on a further-information application; Dublin City uses the code for the
   * two halves of a split decision.
   */
  it("gives a further-information application's informatives to the request", () => {
    const codes = sectionCodes("GRANT PERMISSION", true);
    expect(codes.furtherInfo).toContain("I");
    expect(codes.decision).not.toContain("I");
    // The request is one thing; the decision's own conditions are another.
    expect(codes.furtherInfo).not.toContain("C");
    expect(codes.decision).toContain("C");
  });

  it("leaves a split decision's halves where they belong", () => {
    // Dublin City files the refused half and the granted half as an
    // Informative and a Note. Those are the decision, not a request — even on
    // an application that also went out for further information.
    const codes = sectionCodes("GRANT PERMISSION FOR RETENTION AND REFUSE PERMISSION", true);
    expect(codes.decision).toContain("I");
    expect(codes.decision).toContain("N");
    expect(codes.furtherInfo).not.toContain("I");
  });

  it("keeps informatives with the decision when nothing was ever asked for", () => {
    const codes = sectionCodes("GRANT PERMISSION", false);
    expect(codes.decision).toContain("I");
    expect(codes.furtherInfo).toEqual(["D"]);
  });

  it("never lets a code land in both sections", () => {
    for (const [decision, fi] of [
      ["GRANT PERMISSION", true],
      ["GRANT PERMISSION", false],
      ["REFUSE PERMISSION", true],
      ["GRANT PERMISSION FOR RETENTION AND REFUSE PERMISSION", true],
      [null, true],
    ] as Array<[string | null, boolean]>) {
      const codes = sectionCodes(decision, fi);
      const both = codes.furtherInfo.filter((c) => codes.decision.includes(c));
      expect(both).toEqual([]);
      expect([...codes.furtherInfo, ...codes.decision].sort()).toEqual(
        conditionGroups(decision).map((g) => g.code).sort()
      );
    }
  });
});
