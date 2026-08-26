import { describe, expect, it } from "vitest";
import { cardMeta, cardParts, monthYear } from "../../web/src/components/ChatPanel.js";

/**
 * The line that replaced the card's address heading and description.
 *
 * The card used to restate three things the paragraph above it had just said.
 * What is left has to carry the two the prose does not: whose register the
 * record is in, and when. The address stays only as a label — an answer often
 * cites several properties, and a bare reference gives no way to tell which
 * paragraph a card belongs to.
 */
describe("cardMeta", () => {
  const base = { authority_id: "south-dublin", address_text: "33, Rossberry Avenue, Lucan" };

  it("reads address, council, then when", () => {
    expect(cardMeta({ ...base, decision_date: "2024-08-14" })).toBe(
      "33, Rossberry Avenue, Lucan · South Dublin · decided Aug 2024"
    );
  });

  it("prefers the decision date — it is when the badge's outcome happened", () => {
    expect(cardMeta({ ...base, received_date: "2024-02-02", decision_date: "2024-08-14" })).toContain(
      "decided Aug 2024"
    );
  });

  it("falls back to the received date, labelled as such", () => {
    // Unlabelled, a date beside "Pending decision" reads either way.
    expect(cardMeta({ ...base, received_date: "2026-02-02" })).toBe(
      "33, Rossberry Avenue, Lucan · South Dublin · received Feb 2026"
    );
  });

  it("drops parts it does not have rather than leaving empty separators", () => {
    expect(cardMeta({ authority_id: "fingal" })).toBe("Fingal");
    expect(cardMeta({ authority_id: "fingal", address_text: null, received_date: "2025-01-06" })).toBe(
      "Fingal · received Jan 2025"
    );
  });

  it("says nothing about a council it has no name for", () => {
    // The map is local to the chat card; an unknown id must not print a slug.
    expect(cardMeta({ authority_id: "galway-county", address_text: "Somewhere" })).toBe("Somewhere");
  });

  it("covers every council the agent can return", () => {
    for (const id of [
      "dublin-city", "fingal", "dlr", "south-dublin", "kildare",
      "meath", "wicklow", "cork-city", "cork-county", "wexford",
    ]) {
      expect(cardMeta({ authority_id: id, address_text: "X" }), id).not.toBe("X");
    }
  });
});

describe("monthYear", () => {
  it("shortens to a month and a year", () => {
    expect(monthYear("2024-08-14")).toBe("Aug 2024");
  });

  it("hands back anything it cannot read, rather than NaN", () => {
    expect(monthYear("not a date")).toBe("not a date");
  });
});

/**
 * Split in two so the layout can choose what to drop. Joined as one string the
 * line ran out of room at phone widths and lost the council and the date —
 * the two facts the paragraph above does not carry — while keeping an address
 * the paragraph had already named.
 */
describe("cardParts", () => {
  it("keeps the address separable from the council and date", () => {
    expect(cardParts({
      authority_id: "south-dublin",
      address_text: "33, Rossberry Avenue, Lucan",
      decision_date: "2024-08-14",
    })).toEqual({ where: "33, Rossberry Avenue, Lucan", when: "South Dublin · decided Aug 2024" });
  });

  it("has no `where` when the register holds no address", () => {
    expect(cardParts({ authority_id: "fingal", address_text: "   " }).where).toBeNull();
  });

  it("has no `when` when it knows neither the council nor a date", () => {
    expect(cardParts({ authority_id: "galway-county", address_text: "Somewhere" }).when).toBeNull();
  });
});
