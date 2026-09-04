import { afterEach, describe, expect, it, vi } from "vitest";
import {
  eplanningItemToRecord,
  fetchDetail,
  parseApplicationTypeRaw,
  parseEplanningList,
  parseFullDescription,
  parseFurtherInfoDates,
  parseSiteLocation,
  parseSubmissionsBy,
  parseTotalPages,
} from "../src/ingest/eplanning-list.js";

// Trimmed from the real Kildare searchresults page (Applications Received, 7 days).
const HTML = `
<table class="table table-striped table-bordered table-condensed table-hover">
  <tr>
    <th><a href="/KildareCC/searchresults/File_Number_desc">File Number</a></th>
    <th><a href="/KildareCC/searchresults/application_status">Application Status</a></th>
    <th><a href="/KildareCC/searchresults/decduedate">Decision Due Date</a></th>
    <th><a href="/KildareCC/searchresults/decdate">Decision Date</a></th>
    <th><a href="/KildareCC/searchresults/decisioncode">Decision Code</a></th>
    <th><a href="/KildareCC/searchresults/recvdate">Received Date</a></th>
    <th><a href="/KildareCC/searchresults/applicname">Applicant Name</a></th>
    <th><a href="/KildareCC/searchresults/devaddress">Development Address</a></th>
    <th>Development Description</th>
    <th>Local Authority Name</th>
  </tr>
  <tr>
    <td><a href="/KildareCC/AppFileRefDetails/2660816/0">2660816</a></td>
    <td>NEW APPLICATION</td>
    <td>10/09/2026</td>
    <td></td>
    <td></td>
    <td>17/07/2026</td>
    <td>David Hughes</td>
    <td>4 Whitethorn Grove<br/>Celbridge<br/>County Kildare<br/>W23XY04<br/></td>
    <td>Widen the existing recessed vehicular entrance and adjust the boundary line to footpath...</td>
    <td>Kildare Co. Co.</td>
  </tr>
  <tr>
    <td><a href="/KildareCC/AppFileRefDetails/2660819/0">2660819</a></td>
    <td>NEW APPLICATION</td>
    <td>13/09/2026</td>
    <td></td>
    <td></td>
    <td>17/07/2026</td>
    <td>Heritage Cremation and Burial Gardens Ltd</td>
    <td>Derrymullen,<br/>Allenwood,<br/>Co. Kildare,<br/><br/></td>
    <td>Retention permission for an existing earth berm, and peripheral of site...</td>
    <td>Kildare Co. Co.</td>
  </tr>
</table>
<div>Page 1 of 4 (33 Applications)</div>`;

describe("parseEplanningList", () => {
  it("parses the received-applications results rows", () => {
    const rows = parseEplanningList(HTML);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      eplanningId: "2660816",
      reference: "2660816",
      statusText: "NEW APPLICATION",
      receivedDate: "2026-07-17",
      decisionDueDate: "2026-09-10",
      decisionDate: null,
      applicant: "David Hughes",
    });
    expect(rows[0].address).toBe("4 Whitethorn Grove, Celbridge, County Kildare, W23XY04");
    expect(rows[0].description).toContain("Widen the existing recessed vehicular entrance");
  });

  it("reads the total page count", () => {
    expect(parseTotalPages(HTML)).toBe(4);
    expect(parseTotalPages("<div>no pager</div>")).toBe(1);
  });
});

// The hidden Site Location section of a detail page (AppFileRefDetails/{id}/0).
const SITE_LOCATION_HTML = `
<div id="DivSiteLocation" title="Site Location Section" style="display: none">
<table class="table table-bordered">
  <tr><td colspan="4"><h3>Site Location Details</h3></td></tr>
  <tr>
    <th>Grid Northings:</th><td>736395.02375417</td>
    <th>Grid Eastings:</th><td>698588.1612861</td>
  </tr>
  <tr>
    <th>Site Area:</th><td>0.033</td>
    <th>Area Unit:</th><td>Hectares</td>
  </tr>
</table></div>`;

describe("parseSiteLocation", () => {
  it("converts ITM grid coordinates to a Kildare lat/lng", () => {
    const coords = parseSiteLocation(SITE_LOCATION_HTML);
    expect(coords).not.toBeNull();
    expect(coords!.lat).toBeCloseTo(53.3685, 3);
    expect(coords!.lng).toBeCloseTo(-6.5186, 3);
  });

  it("returns null when the section has no coordinates", () => {
    expect(parseSiteLocation("<div id='DivSiteLocation'>no coords here</div>")).toBeNull();
  });

  it("rejects out-of-range grid values", () => {
    const bad = `<th>Grid Northings:</th><td>0</td><th>Grid Eastings:</th><td>0</td>`;
    expect(parseSiteLocation(bad)).toBeNull();
  });
});

// The Development tab of a detail page, with the full (untruncated) text.
const DEVELOPMENT_HTML = `
<div class="tab-pane fade" id="Development">
  <table class="table">
    <tr><th class="AppDetailsTableHeader" colspan="4"><h4>Proposed Development</h4></th></tr>
    <tr>
      <th>Development Description: </th>
      <td colspan="3">(a) 16 no. single-storey stables with associated shed structures, (b) 1 no. horse walker, (c) and ancillary site works, and permission for the removal of Condition No. 2 attached to Planning Reference No. 01/518</td>
    </tr>
    <tr>
      <th>Development Address: </th>
      <td colspan="3">Newlands North,, Kilcullen,, Co. Kildare</td>
    </tr>
  </table>
</div>`;

// The Details tab of a detail page (labelled th/td pairs, as eplanning emits).
const DETAILS_HTML = `
<table class="table">
  <tr>
    <th valign="top" align="right">Application Type: </th>
    <td> PERMISSION </td>
    <th valign="top" align="right">Planning Status: </th>
    <td>NEW APPLICATION</td>
  </tr>
  <tr>
    <th valign="top" align="right">Commenced Date: </th>
    <td></td>
    <th valign="top" align="right">Submissions By: </th>
    <td> 16/07/2026</td>
  </tr>
  <tr>
    <th valign="top" align="right">Further Info Requested: </th>
    <td>11/04/2002</td>
    <th valign="top" align="right">Further Info Received: </th>
    <td>22/10/2002</td>
  </tr>
</table>`;

describe("parseApplicationTypeRaw", () => {
  it("reads the council's own application type", () => {
    expect(parseApplicationTypeRaw(DETAILS_HTML)).toBe("PERMISSION");
  });

  it("returns null when the field is absent", () => {
    expect(parseApplicationTypeRaw("<table><tr><th>Other: </th><td>x</td></tr></table>")).toBeNull();
  });
});

describe("parseSubmissionsBy", () => {
  it("reads the submissions deadline as ISO", () => {
    expect(parseSubmissionsBy(DETAILS_HTML)).toBe("2026-07-16");
  });

  it("returns null when the cell is empty", () => {
    expect(parseSubmissionsBy("<th>Submissions By: </th><td> </td>")).toBeNull();
  });
});

describe("parseFurtherInfoDates", () => {
  it("reads the further-information request and receipt dates as ISO", () => {
    expect(parseFurtherInfoDates(DETAILS_HTML)).toEqual({
      requested: "2002-04-11",
      received: "2002-10-22",
    });
  });

  it("returns nulls when the application had no further-information round", () => {
    const noFi = `<table><tr>
      <th valign="top" align="right">Further Info Requested: </th><td></td>
      <th valign="top" align="right">Further Info Received: </th><td></td>
    </tr></table>`;
    expect(parseFurtherInfoDates(noFi)).toEqual({ requested: null, received: null });
  });
});

describe("parseFullDescription", () => {
  it("extracts the complete development description", () => {
    const desc = parseFullDescription(DEVELOPMENT_HTML);
    expect(desc).toBe(
      "(a) 16 no. single-storey stables with associated shed structures, " +
        "(b) 1 no. horse walker, (c) and ancillary site works, and permission " +
        "for the removal of Condition No. 2 attached to Planning Reference No. 01/518"
    );
  });

  it("returns null when the field is absent", () => {
    expect(parseFullDescription("<div>no development tab</div>")).toBeNull();
  });
});

describe("eplanningItemToRecord", () => {
  it("maps a NEW APPLICATION row to a pending Kildare record with eircode + type", () => {
    const [row] = parseEplanningList(HTML);
    const rec = eplanningItemToRecord(row, "2026-07-24T00:00:00Z");
    expect(rec.authority_id).toBe("kildare");
    expect(rec.planning_reference).toBe("2660816");
    expect(rec.status).toBe("pending"); // "NEW APPLICATION"
    expect(rec.received_date).toBe("2026-07-17");
    expect(rec.eircode).toBe("W23 XY04"); // pulled from the address
    expect(rec.lat).toBeNull();
    expect(rec.source_url).toBe("https://www.eplanning.ie/KildareCC/AppFileRefDetails/2660816/0");
  });

  it("infers retention from the description", () => {
    const rows = parseEplanningList(HTML);
    const rec = eplanningItemToRecord(rows[1], "2026-07-24T00:00:00Z");
    expect(rec.application_type).toBe("retention");
  });

  it("uses the detail page's application type over guessing from the description", () => {
    // This description has no type keyword, so inference alone yields "other" —
    // the bug the detail-page lookup fixes.
    const [row] = parseEplanningList(HTML);
    expect(eplanningItemToRecord(row, "2026-07-24T00:00:00Z").application_type).toBe("other");
    const enriched = { ...row, applicationTypeRaw: "PERMISSION" };
    const rec = eplanningItemToRecord(enriched, "2026-07-24T00:00:00Z");
    expect(rec.application_type).toBe("permission");
    expect(rec.application_type_raw).toBe("PERMISSION");
  });

  it("carries the submissions deadline onto the record", () => {
    const [row] = parseEplanningList(HTML);
    const rec = eplanningItemToRecord(
      { ...row, submissionsBy: "2026-07-16" },
      "2026-07-24T00:00:00Z"
    );
    expect(rec.submissions_by_date).toBe("2026-07-16");
  });

  it("carries the further-information dates onto the record", () => {
    const [row] = parseEplanningList(HTML);
    const rec = eplanningItemToRecord(
      { ...row, furtherInfoRequested: "2002-04-11", furtherInfoReceived: "2002-10-22" },
      "2026-07-24T00:00:00Z"
    );
    expect(rec.further_info_requested_date).toBe("2002-04-11");
    expect(rec.further_info_received_date).toBe("2002-10-22");
  });
});

/**
 * A detail page that doesn't answer costs a map pin — the record still reads
 * fine in the list and simply never appears on the map, which is how 20 Glen
 * Easton Gardens (2660804) went missing. Measured against the live register on
 * 2026-08-18, 39 of the 1,000 most recently received applications had no
 * coordinates, all Kildare; refetching those pages by hand, 12 parsed cleanly
 * first time. The fetch had failed, not the parser.
 */
describe("fetchDetail retries", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  const PAGE = `<table><tr><th>Grid Northings:</th><td>736395.02375417</td></tr>
    <tr><th>Grid Eastings:</th><td>698588.1612861</td></tr></table>`;

  const stub = (responses: Array<Response | Error>) => {
    let i = 0;
    const calls = { n: 0 };
    globalThis.fetch = vi.fn(async () => {
      calls.n++;
      const r = responses[Math.min(i++, responses.length - 1)];
      if (r instanceof Error) throw r;
      return r;
    }) as unknown as typeof fetch;
    return calls;
  };

  const ok = () => new Response(PAGE, { status: 200 });

  it("recovers a page that failed the first time", async () => {
    const calls = stub([new Error("socket hang up"), ok()]);
    const detail = await fetchDetail("2660804", "c=1");
    expect(calls.n).toBe(2);
    // 736395/698588 in ITM is 20 Glen Easton Gardens, Leixlip.
    expect(detail.coords?.lat).toBeCloseTo(53.36854, 4);
    expect(detail.coords?.lng).toBeCloseTo(-6.51859, 4);
  });

  it("gives up after three attempts rather than hammering the council", async () => {
    const calls = stub([new Error("timeout")]);
    const detail = await fetchDetail("2660804", "c=1");
    expect(calls.n).toBe(3);
    expect(detail.coords).toBeNull();
  });

  it("retries a 500 and a 429, which are worth another go", async () => {
    const calls = stub([new Response("", { status: 503 }), ok()]);
    await fetchDetail("1", "c=1");
    expect(calls.n).toBe(2);
    const rate = stub([new Response("", { status: 429 }), ok()]);
    await fetchDetail("1", "c=1");
    expect(rate.n).toBe(2);
  });

  it("does not retry a 404 — that is an answer, not a failure", async () => {
    const calls = stub([new Response("", { status: 404 })]);
    const detail = await fetchDetail("nope", "c=1");
    expect(calls.n).toBe(1);
    expect(detail.coords).toBeNull();
  });
});
