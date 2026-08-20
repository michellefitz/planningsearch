import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseFileListHtml } from "../../api/_documents/listing.mjs";

/**
 * Real listing pages, saved as fetched. Four systems are behind this one
 * parser and they do not agree on much, so the fixtures are the specification.
 *
 * meath-old is the case that prompted this: Meath 2161, an application from
 * before the councils moved to PDF. Its listing offers every document twice —
 * once as "View" and once as "JPEG" — and the doubled anchors made every row
 * unreadable to the parser.
 */
const FIXTURES = join(__dirname, "fixtures", "listings");
const load = (name: string) => readFileSync(join(FIXTURES, `${name}.html`), "utf8");

const IDOCS_BASE = "https://idocswebdpss.meathcoco.ie/iDocsWebDPSS/listFiles.aspx?catalog=planning&id=2161";
const parse = (name: string, base = IDOCS_BASE) =>
  parseFileListHtml(load(name), base) as Array<{ title: string; url: string; size?: number }>;

describe("a listing that offers every document twice", () => {
  const files = parse("meath-old");

  it("lists each document once, not once per link", () => {
    expect(files).toHaveLength(15);
    expect(new Set(files.map((f) => f.url)).size).toBe(15);
  });

  /** The JPEG link opens a page of JavaScript that fetches tiles from the
   *  councils' DjVu server. There is no file at the end of it, so every one
   *  of these links returned a 502. */
  it("never offers the JPEG link, which cannot produce a file", () => {
    expect(files.filter((f) => /format=jpe?g/i.test(f.url))).toEqual([]);
    expect(files.every((f) => /format=djvu/i.test(f.url))).toBe(true);
  });

  it("names documents from the listing's own columns", () => {
    expect(files.map((f) => f.title)).toContain("Fee Receipt — Application");
    expect(files.map((f) => f.title)).toContain("Site location map — Map");
    expect(files.map((f) => f.title)).toContain("Chief Executives Order — Chief Executive Order - R");
  });

  it("does not name a document after the link that opens it", () => {
    for (const bad of ["JPEG", "View", "downloads", "Document"]) {
      expect(files.map((f) => f.title)).not.toContain(bad);
    }
  });

  it("reads the size the listing prints", () => {
    expect(files.every((f) => typeof f.size === "number")).toBe(true);
    // "17 Mb" and "9 Mb" — both past what a serverless response can carry.
    expect(files.filter((f) => (f.size ?? 0) > 4_000_000)).toHaveLength(2);
  });
});

describe("the DjVu vendor's own download page", () => {
  /** Every iDocs listing carries a link to cuminas.jp, where the DjVu plugin
   *  is downloaded. The word "download" in the href was enough for the
   *  fallback anchor sweep to file it as a drawing. */
  it("is not a planning document", () => {
    for (const name of ["meath-old", "meath-new", "wicklow"]) {
      const files = parse(name);
      expect(files.map((f) => f.url).filter((u) => /cuminas|djvu\.js/i.test(u))).toEqual([]);
    }
  });
});

describe("listings that were already right", () => {
  it("reads a modern Meath listing unchanged", () => {
    const files = parse("meath-new");
    expect(files).toHaveLength(19);
    expect(files[0].title).toBe("Application Form - Part A");
    expect(files.at(-1)?.title).toBe("Site assessment report — Site Assessment");
  });

  it("reads Wicklow", () => {
    const files = parse("wicklow", "https://WicklowCoCo.ePlanning.ie/idocswebDPSS/listFiles.aspx?catalog=planning&id=2660717");
    expect(files).toHaveLength(13);
    expect(files[0].title).toBe("Site assessment report — site assessment");
  });

  it("reads South Dublin, which publishes no sizes", () => {
    const files = parse("southdublin", "https://planning.southdublin.ie/Home/Documents?regref=SD26A%2F0146W");
    expect(files).toHaveLength(35);
    expect(files.every((f) => f.size === undefined)).toBe(true);
    expect(files[1].title).toBe("Application - Cover Letter — 17/06/2026");
  });
});

describe("a listing with nothing published yet", () => {
  /** Kildare 2660938 was received and invalidated within a day. Its rows are
   *  all there, every file "0 Kb", and not one has a link. Nothing to return
   *  is the right answer — better than the vendor link the sweep used to find. */
  it("returns nothing rather than something", () => {
    expect(parse("kildare", "https://idocsweb.kildarecoco.ie/iDocsWebDPSS/listFiles.aspx?catalog=planning&id=2660938")).toEqual([]);
  });
});
