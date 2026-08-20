import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseAppealCase } from "../src/abp.js";
import { appealOutcome, bestAppealDecision } from "../../api/_conditions/appeal.mjs";

/**
 * An Coimisiún Pleanála case 322612, as its page is served.
 *
 * The page says "Decision: Grant Permissions with Conditions" in plain sight.
 * The parser returned zero fields, because the Commission lays each one out as
 * a Foundation grid row — a `case-sub` paragraph in one cell and a
 * `case-summary` paragraph in the next — and every pattern here looked for a
 * label and value that were siblings. With nothing scraped, nothing
 * contradicted a summary written from the inspector's report.
 */
const HTML = readFileSync(join(__dirname, "fixtures", "appeals", "acp-322612.html"), "utf8");
const BASE = "https://www.pleanala.ie/en-ie/case/322612";

describe("the Commission's case page", () => {
  const { fields, documents } = parseAppealCase(HTML, BASE);
  const field = (label: string) =>
    fields.find((f) => f.label.toLowerCase() === label.toLowerCase())?.value;

  it("reads the decision the page states", () => {
    expect(field("Decision")).toBe("Grant Permissions with Conditions");
  });

  it("reads the rest of the summary block", () => {
    expect(field("Case type")).toBe("Planning Appeal");
    expect(field("Date signed")).toBe("19/09/2025");
    expect(field("Description")).toBe("Construction of house and all site works.");
  });

  it("resolves to the outcome the reader is shown", () => {
    const decision = bestAppealDecision(fields, "MODIFIED");
    expect(decision).toBe("Grant Permissions with Conditions");
    expect(appealOutcome(decision)).toMatchObject({
      kind: "granted",
      label: "Granted with conditions",
      conditional: true,
    });
  });

  it("lists the case documents", () => {
    expect(documents.map((d) => d.title)).toEqual([
      "Inspectors Report",
      "Order",
      "Direction",
      "Meeting Records",
    ]);
  });
});

/**
 * The inspector recommends and the Commission decides, and they disagree often
 * enough that reading the wrong one is the whole bug. The Commission lists the
 * inspector's report first.
 */
describe("choosing which document says what was decided", () => {
  const SCORES: Array<[RegExp, number]> = [
    [/\border\b/i, 10],
    [/\bdirection\b/i, 6],
    [/\bdecision|determination\b/i, 5],
    [/\binspector/i, 2],
  ];
  const score = (title: string) => SCORES.find(([re]) => re.test(title))?.[1] ?? 0;

  it("prefers the order over the report that recommended against it", () => {
    const { documents } = parseAppealCase(HTML, BASE);
    const best = [...documents].sort((a, b) => score(b.title) - score(a.title))[0];
    expect(best.title).toBe("Order");
  });

  it("ranks the whole file the way a planner would read it", () => {
    expect(score("Order")).toBeGreaterThan(score("Direction"));
    expect(score("Direction")).toBeGreaterThan(score("Inspectors Report"));
    expect(score("Inspectors Report")).toBeGreaterThan(score("Meeting Records"));
  });
});
