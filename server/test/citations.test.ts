import { describe, expect, it } from "vitest";
import { extractCitations, referenceKey } from "../../api/_related/citations.mjs";

const refs = (text: string, authority: string, own: string | null = null) =>
  extractCitations(text, authority, own).map((c: { reference: string }) => c.reference);

/**
 * 8-16 Annamoe Road, East Cabra — the case that prompted this. Its description
 * names the 2015 original, the 2020 extension of duration and the appeal, and
 * we hold none of the three: the original predates our Dublin City records,
 * and Dublin City publishes no extension-of-duration applications nationally
 * at all.
 */
const ANNAMOE =
  "Permission for modifications to previously granted development, planning ref. no. " +
  "2965/15 (ABP PL29N.245656) and extended by 2965/15/x2 for 4 no. 3-bed 3 storey " +
  "terraced dormer houses at this site.";

describe("extractCitations", () => {
  it("reads all three references out of the Annamoe Road description", () => {
    const found = extractCitations(ANNAMOE, "dublin-city", "4462/22");
    expect(found.map((c: { reference: string }) => c.reference.toUpperCase())).toEqual(
      expect.arrayContaining(["2965/15", "2965/15/X2", "PL29N.245656"])
    );
  });

  it("keeps the extension suffix, which names a different record", () => {
    // Trimming /x2 to the stem would silently merge the 2020 extension of
    // duration into the 2015 permission it extends.
    const found = refs(ANNAMOE, "dublin-city", "4462/22").map((r) => r.toUpperCase());
    expect(found).toContain("2965/15");
    expect(found).toContain("2965/15/X2");
  });

  it("labels an appeal reference as an appeal, not an application", () => {
    const found = extractCitations(ANNAMOE, "dublin-city", "4462/22");
    expect(found.find((c: { reference: string }) => c.reference === "PL29N.245656")?.kind).toBe(
      "appeal"
    );
    expect(found.find((c: { reference: string }) => c.reference === "2965/15")?.kind).toBe(
      "application"
    );
  });

  it("never cites the application itself", () => {
    expect(refs("Amendment to 4462/22 at this site.", "dublin-city", "4462/22")).toEqual([]);
  });

  it("does not read the RED III directive as a planning reference", () => {
    // This is the exact failure a generic digits/slash/digits rule produced,
    // on seven unrelated solar farms.
    const solar =
      "A 10 Year Planning Permission for a solar farm, pursuant to Directive (EU) 2023/2413 " +
      "of the European Parliament.";
    expect(refs(solar, "dublin-city")).toEqual([]);
    expect(refs(solar, "meath")).toEqual([]);
    expect(refs(solar, "cork-county")).toEqual([]);
  });

  it("reads a stand-alone reference for councils whose format is distinctive", () => {
    expect(refs("Block 1 as permitted under Reg. Ref. D98A/0886 is a 7,639 sqm block.", "dlr"))
      .toContain("D98A/0886");
    expect(refs("Amendments to previously granted application Reg. Ref. D25B/0546/WEB.", "dlr"))
      .toContain("D25B/0546/WEB");
  });

  it("requires a cue where the reference is bare digits", () => {
    // Meath references are seven digits, and so is plenty of ordinary prose.
    expect(refs("Construction of 4 no. dwellings over 2500000 square metres.", "meath")).toEqual([]);
    expect(refs("Alterations to the development granted under Reg. Ref. 2160123.", "meath")).toEqual(
      ["2160123"]
    );
  });

  it("does not take a reference-shaped slice out of a longer number", () => {
    expect(refs("Site area of 12965/1500 hectares as shown.", "dublin-city")).toEqual([]);
  });

  it("returns nothing for a council with no known format, or no text", () => {
    expect(refs("Reg. Ref. 12345", "unknown-council")).toEqual([]);
    expect(refs("", "dublin-city")).toEqual([]);
    expect(extractCitations(null, "dublin-city")).toEqual([]);
  });

  it("de-duplicates a reference named more than once", () => {
    const text = "Modifications to Reg. Ref. 2965/15, further to 2965/15 as granted.";
    expect(refs(text, "dublin-city", "4462/22").filter((r) => r.toUpperCase() === "2965/15")).toHaveLength(1);
  });
});

describe("referenceKey", () => {
  it("matches the register's casing and the text's punctuation", () => {
    expect(referenceKey("2965/15/x2")).toBe(referenceKey("2965/15/X2"));
    expect(referenceKey("PL29N.245656")).toBe(referenceKey("pl29n245656"));
  });
});

/**
 * Bare-digit councils, where a reference is just a number and the rules have
 * to be strictest. Found live: Meath 2661024 cites "Reg. Ref. No. 211434", and
 * a five-or-seven-digit format read it as 21143 — a real application, and the
 * wrong one.
 */
describe("bare-digit references", () => {
  it("does not truncate a reference to a shorter valid length", () => {
    expect(refs("Change of house type from that granted under Reg. Ref. No. 211434.", "meath"))
      .toEqual([]);
  });

  it("still reads the lengths the council does issue", () => {
    expect(refs("Alterations to that granted under Reg. Ref. No. 2111434.", "meath")).toEqual([
      "2111434",
    ]);
    expect(refs("Alterations to that granted under Reg. Ref. No. 21143.", "meath")).toEqual([
      "21143",
    ]);
  });

  it("does not take the leading digits of a longer number after a cue", () => {
    expect(refs("Permission granted under Reg. Ref. 123456789.", "cork-city")).toEqual([]);
  });

  it("prefers the longer Cork County form", () => {
    expect(refs("Extension of Duration granted under Planning Ref. No. 21/59091.", "cork-county"))
      .toEqual(["21/59091"]);
    expect(refs("Extension of Duration granted under Planning Ref. No. 21/5909.", "cork-county"))
      .toEqual(["21/5909"]);
  });
});
