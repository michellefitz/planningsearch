import { describe, expect, it } from "vitest";
import { submissionsDeadline } from "../../web/src/components/DetailPanel.js";

/**
 * The one date on the sheet a member of the public can still act on, and it
 * was shown on Kildare and almost nowhere else.
 *
 * Sampled live on 2026-08-21, 40 pending applications per council: Kildare
 * carried a published deadline on 39, every other council on none. The four
 * agile councils publish it on their portals instead, so it arrives with
 * enrichment — but patchily: Dublin City and DLR had it on some applications,
 * Fingal on none. Meath and Wicklow never publish it at all.
 */
const base = {
  submissions_by_date: null,
  received_date: "2026-08-05",
  further_info_requested_date: null,
};

describe("submissionsDeadline", () => {
  it("prefers the council's own published date", () => {
    expect(
      submissionsDeadline({ ...base, submissions_by_date: "2026-09-01" })
    ).toEqual({ date: "2026-09-01", source: "published" });
  });

  it("takes the portal's date when enrichment supplies one", () => {
    // Dublin City, Fingal, DLR and South Dublin publish it on the live portal
    // rather than in the national dataset.
    expect(submissionsDeadline(base, "2026-09-02")).toEqual({
      date: "2026-09-02",
      source: "published",
    });
  });

  it("derives five weeks from receipt where no council publishes one", () => {
    // Article 29 of the Planning and Development Regulations 2001.
    expect(submissionsDeadline(base)).toEqual({ date: "2026-09-09", source: "statutory" });
  });

  it("marks a derived date as derived, so the sheet can say whose date it is", () => {
    // A statutory default is not the same claim as the council's published
    // date, and the panel words them differently.
    expect(submissionsDeadline(base)?.source).toBe("statutory");
    expect(submissionsDeadline({ ...base, submissions_by_date: "2026-09-01" })?.source).toBe(
      "published"
    );
  });

  it("crosses a month boundary correctly", () => {
    expect(submissionsDeadline({ ...base, received_date: "2026-12-20" })?.date).toBe("2027-01-24");
    // 2028 is a leap year: 5 weeks from 4 Feb lands on 10 March, not 11.
    expect(submissionsDeadline({ ...base, received_date: "2028-02-04" })?.date).toBe("2028-03-10");
  });

  it("derives nothing once further information is in play", () => {
    /**
     * Significant further information reopens the window on a fresh newspaper
     * notice whose date we do not hold, so five weeks from receipt is simply
     * the wrong answer — and a confidently wrong deadline on the one date
     * someone might act on is worse than no deadline.
     */
    expect(submissionsDeadline({ ...base, further_info_requested_date: "2026-09-01" })).toBeNull();
  });

  it("still shows a published date even when further information was requested", () => {
    // That one is the council's own statement, not our arithmetic.
    expect(
      submissionsDeadline({
        ...base,
        submissions_by_date: "2026-10-01",
        further_info_requested_date: "2026-09-01",
      })
    ).toEqual({ date: "2026-10-01", source: "published" });
  });

  it("derives nothing without a received date", () => {
    expect(submissionsDeadline({ ...base, received_date: null })).toBeNull();
    expect(submissionsDeadline({ ...base, received_date: "not a date" })).toBeNull();
  });
});
