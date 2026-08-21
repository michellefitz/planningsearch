import { describe, expect, it } from "vitest";
import {
  echoesText,
  isDecisionSchedule,
  isGenericTitle,
  itemLabel,
  scheduleConditionCount,
  snippetFrom,
} from "../../api/_conditions/labels.mjs";
import {
  TITLES_PROMPT,
  cleanTitle,
  parseTitles,
  titlesUserMsg,
  untitledItems,
} from "../../api/_conditions/titles.mjs";

/**
 * What the four agile councils actually put in the title field, taken from
 * their portals. No two of them agree, and only one of them is usable.
 */
const REAL = {
  fingal: {
    title: "1.\tThe development shall be carried out in its entirety in accordanc",
    text: "The development shall be carried out in its entirety in accordance with the plans and particulars lodged with the application.",
  },
  dlrCode: {
    title: "C1",
    text: "1. The development shall be carried out in its entirety in accordance with the plans lodged.",
  },
  dlrSchedule: {
    title: "FS",
    text: "Having regard to the nature and scale of the proposed development, it is considered acceptable.",
  },
  dlrReal: { title: "Drainage", text: "Surface water shall be disposed of within the site." },
  dublinCity: {
    title: "The following Drainage requirements of the Planning Authority shall b",
    text: "2. The following Drainage requirements of the Planning Authority shall be complied with.",
  },
  southDublin: {
    title: "Domestic Extension (Water Services)",
    text: "(a) External Finishes. All external finishes to the development shall harmonise.",
  },
};

describe("titles that are not titles", () => {
  it("recognises the portals' internal codes", () => {
    // DLR renders a whole permission as C1 … C18 with an FS on top.
    for (const code of ["C1", "C18", "FS", "R2", "N"]) expect(isGenericTitle(code)).toBe(true);
  });

  it("recognises a bare number", () => {
    expect(isGenericTitle("3")).toBe(true);
    expect(isGenericTitle("3.")).toBe(true);
  });

  /** A short label that means something is not a code. */
  it("leaves real short titles alone", () => {
    for (const real of ["Drainage", "Trees", "Bins", "Noise"]) {
      expect(isGenericTitle(real)).toBe(false);
    }
  });

  it("recognises a title that is just the wording read back", () => {
    expect(echoesText(REAL.fingal.title, REAL.fingal.text)).toBe(true);
    expect(echoesText(REAL.dublinCity.title, REAL.dublinCity.text)).toBe(true);
  });

  it("does not mistake a real title for an echo", () => {
    expect(echoesText(REAL.southDublin.title, REAL.southDublin.text)).toBe(false);
    expect(echoesText(REAL.dlrReal.title, REAL.dlrReal.text)).toBe(false);
  });
});

describe("the label a row falls back to", () => {
  it("keeps the council's own title where it wrote one", () => {
    expect(itemLabel(REAL.southDublin, 1)).toBe("Domestic Extension (Water Services)");
    expect(itemLabel(REAL.dlrReal, 1)).toBe("Drainage");
  });

  it("names the theme where the wording raises one", () => {
    expect(itemLabel(REAL.dublinCity, 2)).toBe("Drainage");
  });

  /** Never the sentence broken mid-word that this replaces, and never "C1 1",
   *  which is what a code plus a number used to produce. */
  it("falls back to the opening words, cut at a word", () => {
    const label = itemLabel(REAL.fingal, 1);
    expect(label).toBe("The development shall be carried out…");
    expect(itemLabel(REAL.dlrCode, 1)).toBe("The development shall be carried out…");
    expect(label).not.toContain("accordanc ");
  });

  it("never leaves a row blank", () => {
    expect(itemLabel({ title: "", text: "" }, 4)).toBeTruthy();
  });

  it("cuts a snippet at a word, not a character", () => {
    expect(snippetFrom("1. The rooflights shall be in the form of windows only")).toBe(
      "The rooflights shall be in the…"
    );
    expect(snippetFrom("Short one")).toBe("Short one");
  });
});

describe("which conditions need a written title", () => {
  const usable = (i: { title?: string; text?: string }) =>
    !isGenericTitle(i.title) && !echoesText(i.title, i.text);

  it("asks only about the ones their council left untitled", () => {
    const items = [REAL.southDublin, REAL.dlrReal, REAL.fingal, REAL.dlrCode];
    expect(untitledItems(items, usable)).toEqual([REAL.fingal, REAL.dlrCode]);
  });

  it("asks about nothing at all where the council writes real titles", () => {
    expect(untitledItems([REAL.southDublin, REAL.dlrReal], usable)).toEqual([]);
  });

  it("skips items with no wording to title", () => {
    expect(untitledItems([{ title: "C1", text: "   " }], usable)).toEqual([]);
  });
});

describe("the written titles themselves", () => {
  it("keeps a real subject", () => {
    expect(cleanTitle("Construction hours")).toBe("Construction hours");
    expect(cleanTitle("obscure glazing to side windows")).toBe("Obscure glazing to side windows");
  });

  /** The cap is the point of a label — a title that runs to a line is the
   *  thing this whole change replaces. */
  it("holds the five-word cap", () => {
    expect(cleanTitle("Use as a single dwelling unit only and nothing else")).toBe(
      "Use as a single dwelling"
    );
  });

  it("rejects a title that names the instrument rather than the subject", () => {
    for (const bad of ["Condition 4", "Compliance", "Standard condition", "Requirements", "Note"]) {
      expect(cleanTitle(bad)).toBeNull();
    }
  });

  it("rejects nothing and everything", () => {
    expect(cleanTitle("")).toBeNull();
    expect(cleanTitle("a")).toBeNull();
    expect(cleanTitle("x".repeat(80))).toBeNull();
  });

  it("takes only titles for conditions it was asked about, once each", () => {
    const items = [{ order: 1, text: "a" }, { order: 2, text: "b" }];
    const raw =
      'here you go [{"n":1,"title":"Construction hours"},{"n":1,"title":"Duplicate"},' +
      '{"n":2,"title":"Condition 2"},{"n":9,"title":"Not asked"}] done';
    expect(parseTitles(raw, items)).toEqual([{ n: 1, title: "Construction hours" }]);
  });

  it("survives a reply that is not JSON at all", () => {
    expect(parseTitles("I'm sorry, I can't help with that.", [{ order: 1, text: "a" }])).toEqual([]);
  });
});

/**
 * DLR D20A/0569, 36 Mather Road North — the case that prompted both fixes.
 *
 * DLR does not publish its conditions separately. The application carries one
 * "C" item, 4,285 characters long, titled "EK" (the planner's initials), whose
 * text is the decision order itself; and one "I" item that is the
 * further-information request, three numbered asks in a single block.
 */
const DLR_SCHEDULE = `First Schedule
Reasons and Considerations

Having regard to the Objective 'A' zoning of the site and the policies and objectives set out in the Dún Laoghaire-Rathdown County Development Plan 2016-2022, it is considered that the development would not detract from the amenities of the area and is consistent with the provisions of the current County Development Plan. The development is therefore considered to be in accordance with the proper planning and sustainable development of the area subject to (6) conditions.

Second Schedule
Conditions

1. The development shall be carried out in its entirety in accordance with the plans, particulars and specifications lodged with the application.
REASON: To ensure that the development shall be in accordance with the permission.`;

const DLR_REQUEST = `1.  The Planning Authority has concerns that the proposed rear extension, by reason of its height, would appear visually overbearing on No. 34 Mather Road North. The applicant is requested, therefore, to submit revised proposals which address these concerns.

2.  The applicant is requested to confirm the internal gross floor area of the proposed rear and side extensions and the garden studio.`;

describe("a decision filed as one condition", () => {
  it("recognises the schedule headings", () => {
    expect(isDecisionSchedule(DLR_SCHEDULE)).toBe(true);
  });

  it("does not fire on a condition that merely mentions a schedule", () => {
    // Kildare's decision letter says this and is a real condition.
    expect(
      isDecisionSchedule("Subject to the six conditions set out in the Schedule attached hereto.")
    ).toBe(false);
    expect(isDecisionSchedule(DLR_REQUEST)).toBe(false);
    expect(isDecisionSchedule("")).toBe(false);
    expect(isDecisionSchedule(null)).toBe(false);
  });

  it("names it for what it is, over the planner's initials", () => {
    // "EK" is a code, so the old fallbacks took the opening words instead and
    // produced "First Schedule Reasons and Considerations…" — the name of the
    // document's first section rather than of the document.
    expect(itemLabel({ title: "EK", text: DLR_SCHEDULE, order: 2 }, 2)).toBe(
      "Schedule of conditions"
    );
  });
});

describe("titlesUserMsg markers", () => {
  it("cannot be confused with numbering inside a condition", () => {
    /**
     * The marker used to be `--- 2 ---`, indistinguishable from the "2." that
     * opens the second ask of the request above. The model read that ask as
     * condition 2 and titled the decision schedule beside it "Confirm internal
     * floor areas" — a sentence from a different item entirely.
     */
    const msg = titlesUserMsg([
      { order: 1, text: DLR_REQUEST },
      { order: 2, text: DLR_SCHEDULE },
    ]);
    expect(msg).toContain("--- CONDITION #1 ---");
    expect(msg).toContain("--- CONDITION #2 ---");
    // No marker that a numbered point inside the wording could imitate.
    expect(msg).not.toMatch(/^--- \d+ ---$/m);
  });

  it("tells the model what the marker means", () => {
    expect(TITLES_PROMPT).toContain("--- CONDITION #7 ---");
    expect(TITLES_PROMPT).toMatch(/never use one of their numbers as an n/i);
  });
});

describe("counting the conditions inside a schedule", () => {
  /** The real six, abbreviated — numbering and REASON lines as DLR writes them. */
  const SIX = `First Schedule
Reasons and Considerations

The development is considered to be in accordance with the proper planning and sustainable development of the area subject to (6) conditions.

Second Schedule
Conditions

1. The development shall be carried out in its entirety in accordance with the plans lodged.
REASON: To ensure that the development shall be in accordance with the permission.

2. The roof area of the extensions shall not be used as a balcony or roof terrace.
REASON: In the interests of residential amenity.

3. The entire dwelling shall be used as a single dwelling unit.
REASON: To prevent unauthorised development.

4. The proposed garden studio shall be used solely for uses incidental to the dwelling.
REASON: In the interests of residential amenity.

5. The disposal of surface water shall be in accordance with the requirements as follows:

(a) The surface water shall be infiltrated locally, to a soakaway designed to BRE Digest 365.

(b) Any changes to the parking areas shall be constructed in accordance with the GDSDS.
REASON: In the interest of public health.

6. The applicants shall prevent any mud or debris being carried onto the public road.
REASON: In the interest of orderly development.`;

  it("counts the conditions, not the rows the council filed them in", () => {
    // The heading said "Conditions of this decision 1" on a permission
    // carrying six, because DLR files all six as a single item.
    expect(scheduleConditionCount(SIX)).toBe(6);
  });

  it("is not fooled by sub-points or the REASON under each condition", () => {
    // Condition 5 carries (a) and (b), and every condition carries a REASON —
    // counting matches rather than reading the highest number gets this wrong.
    expect(SIX.match(/REASON:/g)).toHaveLength(6);
    expect(scheduleConditionCount(SIX)).toBe(6);
  });

  it("ignores numbering above the conditions heading", () => {
    const withNumberedReasons = `First Schedule
Reasons and Considerations

1. The site is zoned Objective A.
2. The development accords with the plan.
3. It would not injure residential amenity.

Second Schedule
Conditions

1. The development shall be carried out in accordance with the plans lodged.

2. The roof area shall not be used as a balcony.`;
    expect(scheduleConditionCount(withNumberedReasons)).toBe(2);
  });

  it("says nothing about anything that is not a schedule", () => {
    expect(scheduleConditionCount(DLR_REQUEST)).toBeNull();
    expect(scheduleConditionCount("The development shall be carried out as lodged.")).toBeNull();
    expect(scheduleConditionCount(null)).toBeNull();
  });

  it("never claims a count it could not read", () => {
    // A schedule whose conditions are not numbered falls back to the row
    // count, which is what the list already showed.
    const unnumbered = `First Schedule
Reasons and Considerations

The development is acceptable.

Second Schedule
Conditions

The development shall be carried out in accordance with the plans lodged.`;
    expect(scheduleConditionCount(unnumbered)).toBeNull();
  });
});
