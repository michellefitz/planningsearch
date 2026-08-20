import { describe, expect, it } from "vitest";
import { echoesText, isGenericTitle, itemLabel, snippetFrom } from "../../api/_conditions/labels.mjs";
import { cleanTitle, parseTitles, untitledItems } from "../../api/_conditions/titles.mjs";

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
