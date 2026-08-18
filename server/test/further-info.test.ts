import { describe, expect, it } from "vitest";
import {
  FURTHER_INFO_PROMPT,
  cleanSummary,
  findFurtherInfoDocIndex,
  furtherInfoItems,
  furtherInfoSummary,
  furtherInfoUserMsg,
  trimToSummary,
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

  it("keeps a summary that is already the right length untouched", async () => {
    const good =
      "The council wants the layout redesigned to keep more of the Green Road hedgerow and trees, " +
      "and the public open space overlooked rather than fenced. It also wants revised drawings for " +
      "pedestrian and cyclist access and a surface-water design limiting runoff to greenfield rates.";
    expect(await furtherInfoSummary(SD, async () => good)).toBe(good);
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

/**
 * The eplanning councils publish no structured conditions at all, so their
 * request is a scanned letter in the document list. These titles are the real
 * ones from Wicklow 26136's file list, read live on 2026-08-18.
 */
describe("findFurtherInfoDocIndex", () => {
  const WICKLOW = [
    { title: "Report Request Letter to Internal Staff — Internal Referrals" },
    { title: "Report Request Letter to External Body — External Referrals" },
    { title: "Acknowledgement / Validation Letter — Acknowledgement Letter" },
    { title: "Validation Check List — Validation Checklist" },
    { title: "Application - Cover Letter — Cover Letter" },
    { title: "Application Form - Part A — Application Form" },
    { title: "Newspaper Notice — Wicklow People" },
    { title: "Site location map — OS Maps" },
    { title: "F.I. Request Letter — Further Information Request" },
  ];

  it("picks the request letter out of a real file list", () => {
    expect(findFurtherInfoDocIndex(WICKLOW)).toBe(8);
  });

  /**
   * Kildare 25189 (Mount View, Green Lane, Leixlip) carries 103 documents:
   * two requests, roughly thirty of the applicant's answers, and a run of
   * acknowledgements, publication requests and re-advertisement notices. Each
   * of those describes something other than what the council asked for.
   */
  it("takes the most recent request when an application goes round twice", () => {
    const kildare = [
      "Validation Check List — Referrals and Criteria 29/12/2025",
      "Report Request Letter to External Body — EHO 6 1 26",
      "F.I. Request Letter — 19/12/2026",
      "F.I. Received Doc. — 12/05/2026 - Cover Letter",
      "F.I. Receipt Ack. Letter — 13/05/2026",
      "F.I. Publication Request Letter — 18/05/2026",
      "Significant FI News Paper Notice — 22/05/2026",
      "Significant FI Site Notice — 22/05/2026",
      "Notice of FI received to PB and Submitters — 22/05/2026",
      "F.I. Request Letter — 16/06/2026",
      "F.I. Received Doc. — Design Statement",
      "F.I. Clarification Acknowledgement Letter — 17/08/2026",
    ].map((title) => ({ title }));
    // The June letter, not December's — the register appends, so the last
    // request is the operative one.
    expect(findFurtherInfoDocIndex(kildare)).toBe(9);
  });

  it("skips a direction to re-advertise", () => {
    // "F.I. Publication Request Letter" is about the newspaper and the site
    // notice, not about the development, and scores identically otherwise.
    const notices = [
      { title: "F.I. Publication Request Letter — 18/05/2026" },
      { title: "Significant FI News Paper Notice — 22/05/2026" },
      { title: "Significant FI Site Notice — 22/05/2026" },
    ];
    expect(findFurtherInfoDocIndex(notices)).toBe(-1);
  });

  it("never picks the applicant's answer, or an acknowledgement of it", () => {
    // Summarising the response as though it were the request would describe
    // what was supplied, not what was asked for.
    const answered = [
      { title: "F.I. Received Letter — Further Information Received" },
      { title: "Acknowledgement of Further Information" },
      { title: "F.I. Response — drawings submitted" },
    ];
    expect(findFurtherInfoDocIndex(answered)).toBe(-1);
  });

  it("prefers the request over a bare mention of further information", () => {
    const files = [
      { title: "Further information" },
      { title: "F.I. Request Letter" },
    ];
    expect(findFurtherInfoDocIndex(files)).toBe(1);
  });

  it("is -1 when the file list holds no request at all", () => {
    expect(findFurtherInfoDocIndex([{ title: "Site Notice" }, { title: "Fee Receipt" }])).toBe(-1);
    expect(findFurtherInfoDocIndex([])).toBe(-1);
    expect(findFurtherInfoDocIndex(null)).toBe(-1);
  });
});

/**
 * A further-information request is long by nature — Kildare 25189's runs to
 * several pages of trees, open space, cycle crossings, a road-safety audit,
 * drainage and attenuation. Asked to summarise it, the model produced 400
 * words: a rewrite rather than a summary, and worse than the letter, because
 * at that length every clause reads as though it matters equally.
 *
 * The prompt asks for brevity and mostly gets it. "Mostly" is not a guarantee,
 * and the failure is the one the reader sees.
 */
describe("trimToSummary", () => {
  // The opening of what was actually shown on screen.
  const RUNAWAY =
    "The scheme as currently proposed will damage existing plants and wildlife on the site, so you " +
    "must alter the layout and provide updated tree and ecological assessments that link to a new " +
    "detailed landscaping plan. The council is particularly concerned that the current proposal " +
    "retains too few of the existing hedgerow and trees within the public open space and front " +
    "boundary on Green Road (specifically Hedge No. 1, Tree Nos. 12, 13, 14, 15, 16, 18 and 19), so " +
    "efforts must focus on keeping these features. The public open space lacks proper supervision as " +
    "it is currently designed and bordered by wooden garden fencing, which the council will not " +
    "support. You must provide revised drawings showing how pedestrians and cyclists will safely " +
    "enter and cross the site, including kerb treatment at the cycle track crossing. Submit an " +
    "Engineering Services Design Report with full details of surface water drainage.";

  const words = (s: string) => s.trim().split(/\s+/).filter(Boolean).length;

  it("cuts a runaway to the budget", () => {
    expect(words(RUNAWAY)).toBeGreaterThan(140);
    expect(words(trimToSummary(RUNAWAY))).toBeLessThanOrEqual(85);
  });

  it("cuts at a sentence boundary, never mid-clause", () => {
    expect(trimToSummary(RUNAWAY)).toMatch(/[.!?]$/);
  });

  it("keeps the front, which is where the prompt puts what matters", () => {
    // Physical changes first, paperwork last — so what survives a cut is what
    // decides the application.
    expect(trimToSummary(RUNAWAY)).toContain("damage existing plants and wildlife");
    expect(trimToSummary(RUNAWAY)).not.toContain("Engineering Services Design Report");
  });

  it("does not mistake an abbreviation for the end of a sentence", () => {
    // These letters are full of "Hedge No. 1, Tree Nos. 12, 13" — splitting
    // there would cut a sentence into nonsense and spend the budget on it.
    const one = "Keep Hedge No. 1 and Tree Nos. 12, 13 and 14 on the Green Road boundary.";
    expect(trimToSummary(one, 85)).toBe(one);
  });

  it("keeps the first sentence however long, since some is better than none", () => {
    const single = `A single sentence that runs on ${"and on ".repeat(40)}without stopping.`;
    expect(trimToSummary(single, 20)).toBe(single);
  });

  it("leaves a summary already inside the budget exactly as written", () => {
    const good =
      "The council wants the layout redesigned to keep more of the hedgerow. It also wants a " +
      "surface-water design limiting runoff to greenfield rates.";
    expect(trimToSummary(good)).toBe(good);
  });
});

describe("cleanSummary", () => {
  it("is null for nothing usable, so the sheet can say so", () => {
    expect(cleanSummary(null)).toBeNull();
    expect(cleanSummary("")).toBeNull();
    expect(cleanSummary("Unclear.")).toBeNull();
  });

  it("strips Markdown and then applies the budget", () => {
    const out = cleanSummary("## Heading\n- **Move** the extension off the boundary. Submit tests.");
    expect(out).not.toMatch(/[#*]/);
    expect(out).toContain("Move the extension off the boundary.");
  });
});
