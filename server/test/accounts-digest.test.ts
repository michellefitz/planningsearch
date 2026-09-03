import { describe, expect, it } from "vitest";
import { buildDigestEmail, buildSavedAppsEmail } from "../../api/_accounts/digest.mjs";

/**
 * The card leads with what happened, and says when.
 *
 * It used to end with it: address, reference, dates and description first, and
 * the one line explaining why the email existed last. A morning's worth of
 * commencement notices then read as a list of addresses, and the reader had to
 * hunt the bottom of each card to find out what any of it was about.
 */
const ENTRY = {
  address: "12 Main Street, Maynooth",
  reference: "KE26/0123",
  url: "https://planview.test/#app=kildare:KE26%2F0123",
  activity: [{ kind: "decision", text: "Decision issued: GRANT PERMISSION", date: "2026-04-08" }],
  received_date: "2026-01-12",
  decision_date: "2026-04-08",
};

describe("buildSavedAppsEmail", () => {
  it("single entry: subject names the property", () => {
    expect(buildSavedAppsEmail([ENTRY]).subject).toBe("Update on 12 Main Street, Maynooth");
  });

  it("multiple entries: subject counts them", () => {
    const two = [ENTRY, { ...ENTRY, address: "Other House", reference: "F26A/1" }];
    expect(buildSavedAppsEmail(two).subject).toBe("Updates on 2 saved applications");
  });

  it("puts the activity above the address, not below the card", () => {
    const { html } = buildSavedAppsEmail([ENTRY]);
    // Against the address *in the card*, not the one in the subject line,
    // which sits at the top of the mail either way.
    const addressInCard = html.indexOf('color:#1a1d21;">12 Main Street, Maynooth');
    expect(addressInCard).toBeGreaterThan(-1);
    expect(html.indexOf("Decision issued: GRANT PERMISSION")).toBeLessThan(addressInCard);
  });

  it("dates the activity, so a notice filed months ago does not read as today", () => {
    const { html, text } = buildSavedAppsEmail([ENTRY]);
    expect(html).toContain("8 Apr 2026");
    expect(text).toContain("Decision issued: GRANT PERMISSION — 8 Apr 2026");
  });

  it("capitalises Decided in the date line, as Received already was", () => {
    const { html } = buildSavedAppsEmail([ENTRY]);
    expect(html).toContain("Decided 8 Apr 2026");
    expect(html).not.toContain("decided 8 Apr 2026");
  });

  it("prefers the plain-English summary to the council's description", () => {
    const { html } = buildSavedAppsEmail([
      {
        ...ENTRY,
        summary: "A GP surgery replacing a shop, with a new shopfront.",
        description: "Change of Use from Commercial (retail) to Healthcare (General Practitioner) with internal and external alterations including a new shopfront and signage and all associated site works.",
      },
    ]);
    expect(html).toContain("A GP surgery replacing a shop");
    expect(html).not.toContain("Change of Use from Commercial");
  });

  it("falls back to the description, truncated, when nothing was generated", () => {
    const { html } = buildSavedAppsEmail([{ ...ENTRY, description: "x".repeat(400) }]);
    expect(html).toContain("…");
  });

  it("carries every activity line, the reference and the link", () => {
    const entry = {
      ...ENTRY,
      activity: [
        { kind: "decision", text: "Decision issued: GRANT PERMISSION", date: "2026-04-08" },
        { kind: "decision", text: "Final grant issued", date: "2026-05-01" },
      ],
    };
    const { text, html } = buildSavedAppsEmail([entry]);
    for (const out of [text, html]) {
      expect(out).toContain("Decision issued: GRANT PERMISSION");
      expect(out).toContain("Final grant issued");
      expect(out).toContain("KE26/0123");
    }
    expect(text).toContain(ENTRY.url);
    expect(html).toContain(ENTRY.url);
  });

  it("still renders when there is no activity and no date to show", () => {
    const bare = { address: "A", reference: "B", url: "u" };
    expect(() => buildSavedAppsEmail([bare])).not.toThrow();
    expect(buildSavedAppsEmail([bare]).html).toContain("A");
  });
});

describe("buildDigestEmail", () => {
  it("still routes a saved-app digest through the saved-app builder", () => {
    expect(buildDigestEmail([ENTRY]).subject).toBe("Update on 12 Main Street, Maynooth");
  });
});

/**
 * Statuses reach the email already normalised. Running them back through the
 * normaliser, whose rules are written for the register's prose, turned five of
 * the twelve into "Unknown" — including further_info, which is the state an
 * alert is most likely to be reporting.
 */
describe("status badge", () => {
  it.each([
    ["further_info", "Further information"],
    ["split", "Split decision"],
    ["exempt", "Declared exempt"],
    ["not_exempt", "Declared not exempt"],
    ["decided", "Decided"],
    ["granted", "Granted"],
    ["refused", "Refused"],
    ["pending", "Pending decision"],
  ])("renders %s as %s", (status, label) => {
    const { html } = buildSavedAppsEmail([{ ...ENTRY, status }]);
    expect(html).toContain(label);
    expect(html).not.toContain(">Unknown<");
  });

  it("still reads the register's own wording where that is what it gets", () => {
    const { html } = buildSavedAppsEmail([{ ...ENTRY, status: "Decision Notice Issued - GRANT" }]);
    expect(html).toContain("Granted");
  });
});
