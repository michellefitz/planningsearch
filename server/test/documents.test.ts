import { describe, expect, it } from "vitest";
import { deriveScannedFilesUrl, parseFileListHtml } from "../src/documents.js";

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

  it("returns an empty list for unrecognisable markup (deep-link fallback)", () => {
    expect(parseFileListHtml("<html><body>No anchors here</body></html>", base)).toEqual([]);
  });

  it("dedupes repeated links", () => {
    const html = `<a href="a.pdf">A</a><a href="a.pdf">A again</a>`;
    expect(parseFileListHtml(html, base)).toHaveLength(1);
  });
});
