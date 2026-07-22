import { describe, expect, it } from "vitest";
import { findDecisionDocIndex } from "../src/api.js";

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
