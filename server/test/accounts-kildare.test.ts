import { describe, expect, it } from "vitest";
import { snapshotFromDetailHtml } from "../../api/_accounts/kildare.mjs";
import { SNAPSHOT_FIELDS } from "../../api/_accounts/diff.mjs";

/**
 * Structure taken from a real eplanning detail page (AppFileRefDetails/2660628).
 * The tabs matter: "Decision Date" and "Withdrawn Date" each appear in more
 * than one of them, so an unscoped lookup reads the Board's date as the
 * council's.
 */
const page = (o: Record<string, string> = {}) => `
<div class="tab-pane fade in active" id="Details"><table>
  <tr><th valign="top" align="right">Application Type: </th><td> PERMISSION </td>
      <th valign="top" align="right">Planning Status: </th><td>${o.status ?? "NEW APPLICATION"}</td></tr>
  <tr><th valign="top" align="right">Further Info Requested: </th><td>${o.fiReq ?? ""}</td>
      <th valign="top" align="right">Further Info Received: </th><td>${o.fiRec ?? ""}</td></tr>
  <tr><th valign="top" align="right">Withdrawn Date: </th><td>${o.withdrawn ?? ""}</td>
      <th valign="top" align="right">Extend Date: </th><td> </td></tr>
  <tr><th valign="top" align="right">Decision Type: </th><td></td>
      <th valign="top" align="right">Decision Date: </th><td>${o.decDate ?? ""}</td></tr>
  <tr><th valign="top" align="right">Leave to Appeal: </th><td></td>
      <th valign="top" align="right">Appeal Date: </th><td>${o.appealLodged ?? ""}</td></tr>
</table></div>
<div class="tab-pane fade" id="Decision"><table>
  <tr><th class="col-md-2">Decision Date: </th><td>${o.decDate ?? ""}</td></tr>
  <tr><th class="col-md-2">Decision Type: </th><td>${o.decision ?? ""}</td></tr>
  <tr><th class="col-md-2">Grant Date: </th><td>${o.grant ?? ""}</td></tr>
</table></div>
<div class="tab-pane fade" id="Appeal"><table>
  <tr><th class="col-md-2"><abbr title="An Board Pleanala">BP</abbr> Reference #: </th><td>${o.abp ?? ""}</td></tr>
  <tr><th class="col-md-2">Appeal Decision: </th><td>${o.appealDec ?? ""}</td>
      <th class="col-md-2">Decision Date: </th><td>${o.appealDecDate ?? ""}</td></tr>
</table></div>`;

describe("snapshotFromDetailHtml", () => {
  it("returns every snapshot field so it can be diffed directly", () => {
    const snap = snapshotFromDetailHtml(page())!;
    for (const f of SNAPSHOT_FIELDS) expect(snap).toHaveProperty(f);
  });

  it("reads a new application as pending", () => {
    expect(snapshotFromDetailHtml(page())!.status).toBe("pending");
  });

  it("expands the single-letter decision codes the register uses", () => {
    const granted = snapshotFromDetailHtml(page({ decision: "C", decDate: "06/08/2026" }))!;
    expect(granted.decision).toBe("GRANT PERMISSION");
    expect(granted.status).toBe("granted");
    expect(granted.decision_date).toBe("2026-08-06");
    expect(snapshotFromDetailHtml(page({ decision: "R" }))!.status).toBe("refused");
  });

  it("keeps decision text as written when it isn't a code", () => {
    const split = snapshotFromDetailHtml(
      page({ decision: "GRANT PERMISSION AND REFUSE PERMISSION", decDate: "06/08/2026" })
    )!;
    expect(split.status).toBe("split");
    expect(split.decision).toBe("GRANT PERMISSION AND REFUSE PERMISSION");
  });

  it("scopes dates to their tab so an appeal date isn't read as the council's", () => {
    const snap = snapshotFromDetailHtml(
      page({
        decision: "C",
        decDate: "06/08/2026",
        appealLodged: "01/09/2026",
        abp: "ABP-319506-26",
        appealDec: "REFUSE PERMISSION",
        appealDecDate: "20/12/2026",
      })
    )!;
    expect(snap.decision_date).toBe("2026-08-06");
    expect(snap.appeal_decision_date).toBe("2026-12-20");
    // The label is wrapped in an <abbr>, so the matcher has to tolerate markup.
    expect(snap.appeal_reference).toBe("ABP-319506-26");
    // A decided appeal supersedes the council's outcome.
    expect(snap.status).toBe("refused");
    expect(snap.decision).toBe("GRANT PERMISSION");
  });

  it("surfaces further information and withdrawal", () => {
    expect(
      snapshotFromDetailHtml(page({ status: "ADDITIONAL INFORMATION REQUESTED", fiReq: "01/07/2026" }))!
    ).toMatchObject({ status: "further_info", further_info_requested_date: "2026-07-01" });
    expect(snapshotFromDetailHtml(page({ withdrawn: "15/07/2026" }))!.status).toBe("withdrawn");
  });

  it("returns null for an unreadable page rather than a snapshot of nulls", () => {
    // A blank snapshot would diff as every field being cleared at once.
    expect(snapshotFromDetailHtml("<html><body>Service unavailable</body></html>")).toBeNull();
  });
});
