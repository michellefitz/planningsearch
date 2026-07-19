import { describe, expect, it } from "vitest";
import {
  cookieHeaderFromSetCookies,
  countObjectionFiles,
  deriveScannedFilesUrl,
  extractFrameSrc,
  parseEplanningParties,
  parseFileListHtml,
} from "../src/documents.js";

describe("parseEplanningParties", () => {
  // Trimmed from a real eplanning.ie AppFileRefDetails page.
  const HTML = `
    <tr><th class="col-md-2"> Applicant name: </th><td colspan="3"> Trina &amp; John Fanning </td></tr>
    <div id="DivAgents" style="display: none" title="Agent Details">
      <p><table class="table">
        <tr><th width="20%">Name :</th><td width="80%" align="left">  Noeline Devaney</td></tr>
        <tr><th rowspan="4">Address :</th><td align="left">Devaney Williams Architects</td></tr>
        <tr><td align="left">Stream House, Main Street</td></tr>
        <tr><th >Phone :</th><td align="left"></td></tr>
      </table></p>
    </div>`;

  it("extracts applicant and agent (name + practice)", () => {
    expect(parseEplanningParties(HTML)).toEqual({
      applicant: "Trina & John Fanning",
      agent: "Noeline Devaney, Devaney Williams Architects",
    });
  });

  it("returns nulls for pages without either section", () => {
    expect(parseEplanningParties("<html><body>nothing here</body></html>")).toEqual({
      applicant: null,
      agent: null,
    });
  });
});

describe("countObjectionFiles", () => {
  it("counts submission/observation/objection document types", () => {
    expect(
      countObjectionFiles([
        { title: "Third Party Submission — J. Murphy", url: "a" },
        { title: "Submission/ Objection Acknowledgement Letter", url: "b" },
        { title: "Drawings - General — Site Plan", url: "c" },
        { title: "Observation — An Taisce", url: "d" },
      ])
    ).toBe(3);
  });
});

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
  it("finds JavaScript location redirects", () => {
    expect(extractFrameSrc('<script>window.location = "viewer.aspx?id=5";</script>')).toBe(
      "viewer.aspx?id=5"
    );
    expect(extractFrameSrc('<script>document.location.href = "/doc/view.pdf";</script>')).toBe(
      "/doc/view.pdf"
    );
    expect(extractFrameSrc('<script>location.replace("render.aspx?f=1");</script>')).toBe(
      "render.aspx?f=1"
    );
  });
});

describe("deriveScannedFilesUrl", () => {
  it("maps a Kildare eplanning detail URL to the iDocs listing", () => {
    expect(
      deriveScannedFilesUrl("kildare", "https://www.eplanning.ie/KildareCC/AppFileRefDetails/2560786/0")
    ).toBe("https://idocsweb.kildarecoco.ie/iDocsWebDPSS/listFiles.aspx?catalog=planning&id=2560786");
  });

  it("maps a South Dublin reference to the council DMS documents page", () => {
    expect(deriveScannedFilesUrl("south-dublin", null, "SD25A/0157W")).toBe(
      "https://planning.southdublin.ie/Home/Documents?regref=SD25A%2F0157W"
    );
  });

  it("maps a Dublin City reference to the PublicAccess document search", () => {
    expect(deriveScannedFilesUrl("dublin-city", null, "3526/22")).toBe(
      "https://webapps.dublincity.ie/PublicAccess_Live/SearchResult/RunThirdPartySearch?FileSystemId=PL&Folder1_Ref=3526/22"
    );
    // Spaces and other characters still get encoded; only the slash stays raw.
    expect(deriveScannedFilesUrl("dublin-city", null, "WEB 1234/25")).toContain(
      "Folder1_Ref=WEB%201234/25"
    );
  });

  it("returns null for other authorities and unknown URL shapes", () => {
    expect(deriveScannedFilesUrl("dublin-city", "https://planning.agileapplications.ie/dublincity/x/1")).toBeNull();
    expect(deriveScannedFilesUrl("fingal", null, "F25A/0101")).toBeNull();
    expect(deriveScannedFilesUrl("kildare", "https://www.eplanning.ie/KildareCC/searchtypes?query=x")).toBeNull();
    expect(deriveScannedFilesUrl("kildare", null)).toBeNull();
    expect(deriveScannedFilesUrl("south-dublin", null, null)).toBeNull();
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
      "Application Form — 02/06/2026",
      "Site Location Map — 02/06/2026",
      "Planner's Report — 10/07/2026",
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

describe("agile document parsing (verified /api/application/{id}/document shape)", () => {
  // A trimmed slice of a real Fingal response.
  const RESPONSE = [
    {
      documentHash: "SB6XY5JCGJSJTDDMW677",
      documentId: "1045467",
      name: "00125498_P001N01L_20240722_1030.pdf",
      description: "Site Notice",
      mediaDescription: "Site Notice",
    },
    {
      documentHash: "SB6XY5JCGJH9DY3QPX6L",
      documentId: "1045468",
      name: "00125504_P001N01D_20240722_1030.pdf",
      description: "Application Form - Part A",
      mediaDescription: "Application Form - Part A",
    },
  ];

  it("titles files by description, not the raw filename", async () => {
    const { parseAgileDocuments } = await import("../src/agile.js");
    const files = parseAgileDocuments(RESPONSE);
    expect(files.map((f) => f.title)).toEqual(["Site Notice", "Application Form - Part A"]);
    expect(files[0].url).toContain("/document/SB6XY5JCGJSJTDDMW677");
  });

  it("keeps hash and id for the download proxy", async () => {
    const { parseAgileDocEntries } = await import("../src/agile.js");
    const entries = parseAgileDocEntries(RESPONSE);
    expect(entries[0]).toEqual({
      title: "Site Notice",
      documentId: "1045467",
      documentHash: "SB6XY5JCGJSJTDDMW677",
    });
  });

  it("tolerates a wrapper object and skips entries without hash or id", async () => {
    const { parseAgileDocEntries } = await import("../src/agile.js");
    expect(parseAgileDocEntries({ documents: RESPONSE })).toHaveLength(2);
    expect(parseAgileDocEntries([{ description: "no keys" }])).toHaveLength(0);
  });
});
