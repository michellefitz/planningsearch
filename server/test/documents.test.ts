import { describe, expect, it } from "vitest";
import {
  cookieHeaderFromSetCookies,
  deriveScannedFilesUrl,
  extractFrameSrc,
  parseFileListHtml,
} from "../src/documents.js";

describe("cookieHeaderFromSetCookies", () => {
  it("keeps only the name=value pair from each Set-Cookie", () => {
    expect(
      cookieHeaderFromSetCookies([
        "ASP.NET_SessionId=abc123; path=/; HttpOnly",
        "prefs=x; Expires=Wed, 21 Oct 2026 07:28:00 GMT; Secure",
      ])
    ).toBe("ASP.NET_SessionId=abc123; prefs=x");
  });
  it("handles the empty case", () => {
    expect(cookieHeaderFromSetCookies([])).toBe("");
  });
});

describe("extractFrameSrc", () => {
  it("finds iframe, object and meta-refresh targets", () => {
    expect(extractFrameSrc('<iframe id="v" src="render.aspx?doc=1"></iframe>')).toBe(
      "render.aspx?doc=1"
    );
    expect(extractFrameSrc('<object data="/docs/x.pdf" type="application/pdf"></object>')).toBe(
      "/docs/x.pdf"
    );
    expect(
      extractFrameSrc('<meta http-equiv="refresh" content="0;url=viewer.aspx?id=9">')
    ).toBe("viewer.aspx?id=9");
    expect(extractFrameSrc("<p>plain page</p>")).toBeNull();
  });
});

describe("deriveScannedFilesUrl", () => {
  it("maps a Kildare eplanning detail URL to the iDocs listing", () => {
    expect(
      deriveScannedFilesUrl("kildare", "https://www.eplanning.ie/KildareCC/AppFileRefDetails/2560786/0")
    ).toBe("https://idocsweb.kildarecoco.ie/iDocsWebDPSS/listFiles.aspx?catalog=planning&id=2560786");
  });

  it("returns null for other authorities and unknown URL shapes", () => {
    expect(deriveScannedFilesUrl("dublin-city", "https://planning.agileapplications.ie/dublincity/x/1")).toBeNull();
    expect(deriveScannedFilesUrl("kildare", "https://www.eplanning.ie/KildareCC/searchtypes?query=x")).toBeNull();
    expect(deriveScannedFilesUrl("kildare", null)).toBeNull();
  });
});

describe("parseFileListHtml", () => {
  const base = "https://idocsweb.kildarecoco.ie/iDocsWebDPSS/listFiles.aspx?catalog=planning&id=1";

  it("collects document-looking anchors and resolves relative URLs", () => {
    const html = `
      <table>
        <tr><td><a href="getFile.aspx?catalog=planning&fileid=101">Application Form</a></td></tr>
        <tr><td><a href="/iDocsWebDPSS/docs/site-plan.pdf"><b>Site Plan</b></a></td></tr>
        <tr><td><a href="#top">Back to top</a></td></tr>
        <tr><td><a href="javascript:void(0)">Print</a></td></tr>
        <tr><td><a href="listFiles.aspx?page=2">Next page</a></td></tr>
      </table>`;
    const files = parseFileListHtml(html, base);
    expect(files).toEqual([
      {
        title: "Application Form",
        url: "https://idocsweb.kildarecoco.ie/iDocsWebDPSS/getFile.aspx?catalog=planning&fileid=101",
      },
      {
        title: "Site Plan",
        url: "https://idocsweb.kildarecoco.ie/iDocsWebDPSS/docs/site-plan.pdf",
      },
    ]);
  });

  it("uses row text as the title when the link label is a generic 'View' (iDocs GridView)", () => {
    const html = `
      <table id="gvFiles">
        <tr><th>Document</th><th>Date</th><th></th></tr>
        <tr><td>Application Form</td><td>02/06/2026</td><td><a href="getFile.aspx?fileid=1">View</a></td></tr>
        <tr><td>Site Location Map</td><td>02/06/2026</td><td><a href="getFile.aspx?fileid=2">View</a></td></tr>
        <tr><td>Planner's Report</td><td>10/07/2026</td><td><a href="getFile.aspx?fileid=3">View</a></td></tr>
      </table>`;
    const files = parseFileListHtml(html, base);
    expect(files.map((f) => f.title)).toEqual([
      "Application Form 02/06/2026",
      "Site Location Map 02/06/2026",
      "Planner's Report 10/07/2026",
    ]);
    expect(files[0].url).toContain("fileid=1");
  });

  it("returns an empty list for unrecognisable markup (deep-link fallback)", () => {
    expect(parseFileListHtml("<html><body>No anchors here</body></html>", base)).toEqual([]);
  });

  it("dedupes repeated links", () => {
    const html = `<a href="a.pdf">A</a><a href="a.pdf">A again</a>`;
    expect(parseFileListHtml(html, base)).toHaveLength(1);
  });
});
