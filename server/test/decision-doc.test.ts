import { describe, expect, it } from "vitest";
import { findConditionsScheduleIndex, findDecisionDocIndex } from "../src/api.js";

describe("findDecisionDocIndex", () => {
  it("picks the council refusal order, not the appeal or a Part V order (Kildare 211277)", () => {
    const files = [
      { title: "Application Form" },
      { title: "Site Location Map" },
      { title: "Part V Exemption Application Form — Managers Order 14/09/2021" },
      { title: "Notification of Decision to Refuse Permission" },
      { title: "An Bord Pleanála Board Order — Appeal Decision" },
      { title: "Inspector's Report" },
    ];
    const i = findDecisionDocIndex(files, "REFUSE PERMISSION");
    expect(files[i].title).toBe("Notification of Decision to Refuse Permission");
  });

  it("never picks an appeal/board document even when it is the only 'order'", () => {
    const files = [
      { title: "Application Form" },
      { title: "An Bord Pleanála Board Order" },
      { title: "Inspector's Report" },
    ];
    // No council decision order present → -1 (empty state), not the board order.
    expect(findDecisionDocIndex(files, "REFUSE PERMISSION")).toBe(-1);
  });

  it("prefers the document consistent with the recorded outcome", () => {
    const files = [
      { title: "Manager's Order — Grant of Permission (earlier reg ref)" },
      { title: "Notification of Decision to Refuse Permission" },
    ];
    expect(files[findDecisionDocIndex(files, "REFUSE PERMISSION")].title).toBe(
      "Notification of Decision to Refuse Permission"
    );
  });

  it("still finds a plain council decision order for a normal (unappealed) case", () => {
    const files = [
      { title: "Site Notice" },
      { title: "Notification of Decision to Grant Permission" },
    ];
    expect(files[findDecisionDocIndex(files, "GRANT PERMISSION")].title).toBe(
      "Notification of Decision to Grant Permission"
    );
  });
});

/**
 * Kildare issues a decision in two documents, and only the second one has the
 * conditions in it. Ard Rossa, Ballygoran, Maynooth rendered as "Conditions of
 * grant 1 — Subject to 6 conditions set out in the schedule attached.
 * [Schedule not provided in document]": the reader was told there were six and
 * shown none of them, and the schedule was sitting in the same file list.
 */
describe("findConditionsScheduleIndex", () => {
  const KILDARE = [
    { title: "Application - Cover Letter — 19/12/2019 - Drawing Schedule" },
    { title: "Chief Executives Order — DO27762" },
    { title: "Notification of Decision Letters — 18/02/2020" },
    { title: "Schedule of Conditions — 18/02/2020" },
    { title: "Schedule of Conditions" },
  ];

  it("finds the schedule that goes with the decision", () => {
    const decision = findDecisionDocIndex(KILDARE, "CONDITIONAL");
    expect(KILDARE[decision].title).toBe("Notification of Decision Letters — 18/02/2020");
    const schedule = findConditionsScheduleIndex(KILDARE, decision);
    // The dated one — the undated duplicate is a working copy filed later.
    expect(KILDARE[schedule].title).toBe("Schedule of Conditions — 18/02/2020");
  });

  it("is not fooled by a schedule of drawings", () => {
    expect(findConditionsScheduleIndex([KILDARE[0]], -1)).toBe(-1);
  });

  it("never returns the document already being read", () => {
    const files = [{ title: "Schedule of Conditions — 18/02/2020" }];
    expect(findConditionsScheduleIndex(files, 0)).toBe(-1);
  });

  it("says there is none where the council keeps them in the order itself", () => {
    const files = [{ title: "Notification of Decision to Grant Permission" }];
    expect(findConditionsScheduleIndex(files, 0)).toBe(-1);
  });
});
