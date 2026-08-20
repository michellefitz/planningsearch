import { describe, expect, it } from "vitest";
import {
  appealOutcome,
  bestAppealDecision,
  contradictsOutcome,
} from "../../api/_conditions/appeal.mjs";

/**
 * Meath 2460813, Arodstown, Summerhill — the case this came from.
 *
 * The council refused. The inspector recommended upholding the refusal. The
 * Commission granted permission with conditions. The sheet read the inspector's
 * report, announced that "the refusal should stand", and printed it directly
 * above a decision line that said otherwise.
 */
describe("reading the Commission's own wording", () => {
  it("reads its grants, however they are phrased", () => {
    for (const text of [
      "Grant Permissions with Conditions",
      "Grant permission with revised conditions",
      "Grant permission with conditions",
    ]) {
      expect(appealOutcome(text)).toMatchObject({ kind: "granted", label: "Granted with conditions" });
    }
    expect(appealOutcome("Grant Permission")).toMatchObject({ kind: "granted", label: "Granted" });
  });

  it("reads its refusals", () => {
    expect(appealOutcome("Refuse Permission")).toMatchObject({ kind: "refused", label: "Refused" });
    expect(appealOutcome("REFUSED")).toMatchObject({ kind: "refused" });
  });

  it("says what a dismissal actually means for the reader", () => {
    expect(appealOutcome("DISMISSED").label).toBe(
      "Appeal dismissed — the council's decision stands"
    );
  });

  it("does not treat a money appeal as a decision about the building", () => {
    expect(appealOutcome("Contribution Appeal Decided")).toMatchObject({ kind: "other" });
  });
});

/**
 * Checked against the Commission's case pages for every MODIFIED appeal on the
 * three eplanning councils: twelve of fifteen were grants with conditions, two
 * were contribution appeals, one had nothing published. Usually granted is not
 * a basis for telling someone their neighbour's house was approved.
 */
describe("the register's coarser codes", () => {
  it("refuses to read MODIFIED as an outcome", () => {
    expect(appealOutcome("MODIFIED")).toMatchObject({ kind: null, label: null });
    for (const near of ["Modified", " modified ", "AMENDED", "varied"]) {
      expect(appealOutcome(near).kind).toBeNull();
    }
  });

  it("still reads the codes that do name one", () => {
    expect(appealOutcome("CONDITIONAL").kind).toBe("granted");
    expect(appealOutcome("WITHDRAWN").kind).toBe("withdrawn");
  });

  it("has nothing to say about nothing", () => {
    expect(appealOutcome(null).kind).toBeNull();
    expect(appealOutcome("").kind).toBeNull();
  });
});

describe("choosing between the two sources", () => {
  const caseFields = [
    { label: "Case type", value: "Planning Appeal" },
    { label: "Decision", value: "Grant Permissions with Conditions" },
  ];

  it("prefers the Commission's wording over the register's code", () => {
    expect(bestAppealDecision(caseFields, "MODIFIED")).toBe("Grant Permissions with Conditions");
  });

  it("falls back to the register when the case page said nothing", () => {
    expect(bestAppealDecision([], "MODIFIED")).toBe("MODIFIED");
    expect(bestAppealDecision(null, null)).toBeNull();
  });

  it("keeps the register's code when the case page's decision is unreadable", () => {
    expect(bestAppealDecision([{ label: "Decision", value: "Under consideration" }], "REFUSED"))
      .toBe("Under consideration");
  });
});

describe("catching a summary that says the opposite", () => {
  /** Verbatim from the summary that prompted this. */
  const THE_BUG =
    "An Coimisiún Pleanála's inspector examined his application carefully and decided the " +
    "refusal should stand. Although Prunty demonstrated genuine connections to the area…";

  it("catches the case that started this", () => {
    expect(contradictsOutcome(THE_BUG, "granted")).toBe(true);
  });

  it("catches the same mistake the other way round", () => {
    expect(contradictsOutcome("The Commission granted permission for the house.", "refused")).toBe(true);
    expect(contradictsOutcome("The Commission overturned the council's refusal.", "refused")).toBe(true);
  });

  /** Mentioning the council's refusal is not claiming the appeal failed —
   *  nearly every summary of a successful appeal has to mention it. */
  it("does not fire on a summary that merely recounts the history", () => {
    expect(
      contradictsOutcome(
        "The council refused permission because the site is in a rural area under strong urban " +
          "influence. The Commission granted permission subject to conditions.",
        "granted"
      )
    ).toBe(false);
  });

  it("says nothing when there is no outcome to contradict", () => {
    expect(contradictsOutcome(THE_BUG, null)).toBe(false);
    expect(contradictsOutcome(null, "granted")).toBe(false);
  });
});
