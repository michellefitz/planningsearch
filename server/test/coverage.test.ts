import { describe, expect, it } from "vitest";
// The helper lives with the UI that renders it; the suite lives here.
import { coverageNoteFor, coverageSummary, coverageYear } from "../../web/src/coverage.js";
import type { Meta } from "../../web/src/api.js";

/** Real floors, measured against the live feed on 2026-07-30. */
const META = {
  authorities: [
    { id: "dublin-city", short_name: "Dublin City", earliest_received: "2019-01-02", application_count: 24716 },
    { id: "fingal", short_name: "Fingal", earliest_received: "2011-01-04", application_count: 20123 },
    { id: "dlr", short_name: "Dún Laoghaire-Rathdown", earliest_received: "2001-01-02", application_count: 38400 },
    { id: "south-dublin", short_name: "South Dublin", earliest_received: "1992-01-02", application_count: 33073 },
    { id: "kildare", short_name: "Kildare", earliest_received: "2017-01-03", application_count: 15384 },
  ],
} as unknown as Meta;

describe("coverage floors", () => {
  it("names the shallowest register first, since that is the trap", () => {
    const s = coverageSummary(META)!;
    expect(s.indexOf("Dublin City from 2019")).toBeLessThan(s.indexOf("South Dublin from 1992"));
    expect(s).toContain("Kildare from 2017");
  });

  it("scopes to one council for a page about one property", () => {
    expect(coverageNoteFor(META, "dublin-city")).toBe(
      "We hold Dublin City's register from 2019 — anything earlier won't appear here."
    );
    expect(coverageYear(META, "south-dublin")).toBe("1992");
  });

  it("says nothing rather than something wrong when it has no floor", () => {
    // A caller with no meta yet, or an authority we hold nothing for, must get
    // null so the caller falls back — never "from undefined".
    expect(coverageSummary(null)).toBeNull();
    expect(coverageNoteFor(null, "dublin-city")).toBeNull();
    expect(coverageNoteFor(META, "not-an-authority")).toBeNull();
    const empty = { authorities: [{ id: "x", short_name: "X", earliest_received: null, application_count: 0 }] } as unknown as Meta;
    expect(coverageSummary(empty)).toBeNull();
  });
});
