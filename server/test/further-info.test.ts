import { describe, expect, it } from "vitest";
import {
  FURTHER_INFO_PROMPT,
  furtherInfoItems,
  furtherInfoSummary,
  furtherInfoUserMsg,
} from "../../api/_conditions/further-info.mjs";

/**
 * Real items from South Dublin SD25A/0308W, the case that prompted this: a
 * house extension whose "decision" read "Seek Clarification of Additional
 * Information" and whose request ran to several thousand words.
 */
const SD = [
  {
    code: "D",
    order: 1,
    title: "Amendments to proposed two storey side extension.",
    text: "While the general overall form, profile and layout of the proposed extension would be acceptable in principle, as the proposed two storey side extension would be built on and form part of the side (southern) boundary of the subject site onto the adjoining public realm, this element of the proposal would not accord with the provisions of BFP3 of the 2025 SDCC House Extension Design Guide.",
  },
  {
    code: "D",
    order: 3,
    title: "SDCC Water Services",
    text: "1.1 SuDS are preferred over soakaways. If soakaways are to be proposed, then soil percolation tests are needed as per BRE Digest 365. The applicant is requested to submit soil percolation test results and design calculations.",
  },
  {
    code: "I",
    order: 2,
    title: "Omission of secondary front door entrance to front elevation of dwelling.",
    text: "The provision of a second access door would have the potential to facilitate the use of the extension element as a residential unit separate from the existing dwelling. The applicant is therefore requested to submit revised plans.",
  },
  // Everything else on the file is not part of the request.
  { code: "C", order: 1, title: "C1", text: "Build in accordance with the lodged plans." },
  { code: "N", order: 0, title: "NOTES", text: "NOTE 1: Section 34(13) applies." },
  { code: "D", order: 9, title: "blank", text: "   " },
];

describe("furtherInfoItems", () => {
  it("takes the directives and informatives that carry the request", () => {
    expect(furtherInfoItems(SD).map((i) => `${i.code}${i.order}`)).toEqual(["D1", "D3", "I2"]);
  });

  it("is empty when the file holds no request", () => {
    expect(furtherInfoItems([{ code: "C", order: 1, text: "A condition." }])).toEqual([]);
    expect(furtherInfoItems(null)).toEqual([]);
    expect(furtherInfoItems(undefined)).toEqual([]);
  });
});

describe("furtherInfoUserMsg", () => {
  it("labels each item by what it is, so the model can tell the ask from the reasoning", () => {
    const msg = furtherInfoUserMsg(furtherInfoItems(SD));
    expect(msg).toContain("--- Requirement 1: Amendments to proposed two storey side extension. ---");
    expect(msg).toContain("--- Requirement 3: SDCC Water Services ---");
    expect(msg).toContain("--- Note 2: Omission of secondary front door");
    expect(msg).not.toContain("Build in accordance");
  });

  it("caps a pathological request rather than sending it whole", () => {
    const huge = [{ code: "D", order: 1, title: "x", text: "y".repeat(40000) }];
    expect(furtherInfoUserMsg(huge).length).toBe(24000);
  });
});

describe("furtherInfoSummary", () => {
  it("does not call the model when there is no request to read", async () => {
    let called = false;
    const out = await furtherInfoSummary([{ code: "C", order: 1, text: "A condition." }], async () => {
      called = true;
      return "text";
    });
    expect(called).toBe(false);
    expect(out).toBeNull();
  });

  it("sends only the request, and the prompt that asks for the ask", async () => {
    let seenSystem = "";
    let seenContent = "";
    await furtherInfoSummary(SD, async (system: string, content: string) => {
      seenSystem = system;
      seenContent = content;
      return "The council wants the side extension pulled back off the southern boundary and the second front door dropped. It also wants percolation tests and revised drawings.";
    });
    expect(seenSystem).toBe(FURTHER_INFO_PROMPT);
    expect(seenContent).toContain("BRE Digest 365");
    expect(seenContent).not.toContain("Section 34(13)");
  });

  it("strips Markdown the model reaches for despite being told not to", async () => {
    const out = await furtherInfoSummary(
      SD,
      async () => "## What is needed\n- **Move** the extension off the boundary.\n- Submit percolation tests."
    );
    expect(out).not.toMatch(/[#*]/);
    expect(out).toContain("Move the extension off the boundary.");
  });

  it("passes a model failure through as null", async () => {
    expect(await furtherInfoSummary(SD, async () => null)).toBeNull();
    // A one-word reply is a failure wearing a hat, not a summary.
    expect(await furtherInfoSummary(SD, async () => "Unclear.")).toBeNull();
  });
});
