import { describe, expect, it } from "vitest";
import { relatedNarrative } from "../../web/src/components/DetailPanel.js";

/**
 * The line under the address that says there is more history here.
 *
 * The direction is the point. An earlier application is the site's history; a
 * later one is often the thing the reader came for and cannot see — a refusal
 * resubmitted six months on, a permission already superseded. Reading the old
 * application and never learning the new one exists is the failure this line
 * exists to prevent, so "more recent" must never be reported as "earlier".
 */
const AT = "at this address";
const on = (received_date: string | null) => ({ received_date });

describe("relatedNarrative", () => {
  it("says nothing when there is nothing to say", () => {
    expect(relatedNarrative([], "2026-01-01", AT)).toBeNull();
  });

  it("counts earlier applications", () => {
    expect(relatedNarrative([on("2019-04-02")], "2026-01-01", AT)).toBe(
      "1 earlier application at this address"
    );
    expect(
      relatedNarrative([on("2019-04-02"), on("2021-06-01"), on("2024-02-20")], "2026-01-01", AT)
    ).toBe("3 earlier applications at this address");
  });

  it("calls out a later application, which is the one the reader is missing", () => {
    expect(relatedNarrative([on("2026-05-04")], "2026-01-01", AT)).toBe(
      "1 more recent application at this address"
    );
    expect(relatedNarrative([on("2026-05-04"), on("2026-07-11")], "2026-01-01", AT)).toBe(
      "2 more recent applications at this address"
    );
  });

  it("reports both directions when the site has history either side", () => {
    expect(
      relatedNarrative([on("2026-05-04"), on("2019-04-02"), on("2021-06-01")], "2026-01-01", AT)
    ).toBe("1 more recent and 2 earlier applications at this address");
  });

  it("singularises the earlier half of a mixed sentence", () => {
    expect(relatedNarrative([on("2026-05-04"), on("2019-04-02")], "2026-01-01", AT)).toBe(
      "1 more recent and 1 earlier application at this address"
    );
  });

  it("treats the same day as not more recent", () => {
    expect(relatedNarrative([on("2026-01-01")], "2026-01-01", AT)).toBe(
      "1 earlier application at this address"
    );
  });

  it("falls back to a plain count when a related application has no date", () => {
    // "2 earlier applications" would be a claim about chronology we cannot make.
    expect(relatedNarrative([on("2019-04-02"), on(null)], "2026-01-01", AT)).toBe(
      "2 other applications at this address"
    );
  });

  it("falls back when this application itself has no received date", () => {
    expect(relatedNarrative([on("2019-04-02")], null, AT)).toBe(
      "1 other application at this address"
    );
  });

  it("takes the wording from the caller, since Kildare's list is not an address match", () => {
    expect(relatedNarrative([on("2019-04-02")], "2026-01-01", "linked to this one")).toBe(
      "1 earlier application linked to this one"
    );
  });
});
