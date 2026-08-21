import { describe, expect, it } from "vitest";
import {
  FURTHER_INFO_PROMPT,
  cleanSummary,
  RETURNED_POST_RE,
  findFurtherInfoDocIndex,
  furtherInfoItems,
  titleDate,
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

/**
 * South Dublin's request letter, and why we now look for one at all.
 *
 * South Dublin is an agile council, so the request is meant to arrive as
 * structured "D" items — but its conditions endpoint answers nothing until a
 * decision issues. SD26B/0100W was asked for more in April 2026 and answered
 * in July, and was still undecided in August: no conditions, so no summary,
 * and the sheet fell back to a note written for the eplanning councils. The
 * letter is on the file the whole time, under South Dublin's own name for it.
 *
 * Titles are the real ones from SD26B/0100W's file list, read live on
 * 2026-08-21.
 */
describe("findFurtherInfoDocIndex on South Dublin", () => {
  const SOUTH_DUBLIN = [
    { title: "Acknowledgement / Validation Letter — 11/03/2026" },
    { title: "Application Form - Part A — 11/03/2026" },
    { title: "Drawings - General — 11/03/2026" },
    { title: "Newspaper Notice — 11/03/2026" },
    { title: "Site Notice — 11/03/2026" },
    { title: "Site Notice Site Inspection Sheet — 19/03/2026" },
    { title: "Chief Executives Order ADDITIONAL INFORMATION — 27/04/2026" },
    { title: "Notification of Decision ADDITIONAL INFORMATION — 27/04/2026" },
    { title: "Notification of Decision ADDITIONAL INFORMATION — 28/04/2026" },
    { title: "F.I. Receipt Ack. Letter — 14/07/2026" },
    { title: "F.I. Received Doc. Ground Floor Plans (FI Code 18633) — 14/07/2026" },
    { title: "F.I. Received Doc. Cover Letter — 14/07/2026" },
    { title: "Chief Executives Order Chief Executives Order — 23/07/2026" },
    { title: "Notification of Decision Notification of Decision — 23/07/2026" },
  ];

  it("finds the request under South Dublin's own name for it", () => {
    // Not "F.I. Request Letter" — South Dublin issues it as a Notification of
    // Decision stamped ADDITIONAL INFORMATION.
    expect(findFurtherInfoDocIndex(SOUTH_DUBLIN)).toBe(8);
  });

  it("does not mistake the applicant's answers for the request", () => {
    const picked = findFurtherInfoDocIndex(SOUTH_DUBLIN);
    expect(SOUTH_DUBLIN[picked].title).not.toMatch(/Received|Receipt/i);
  });

  it("does not mistake the actual decision for the request", () => {
    const picked = findFurtherInfoDocIndex(SOUTH_DUBLIN);
    expect(SOUTH_DUBLIN[picked].title).toMatch(/ADDITIONAL INFORMATION/);
  });
});

/**
 * Meath 212214 — Trammon, a 206-hectare solar farm.
 *
 * Meath files undelivered mail beside the original under the same document
 * type. This application carries three documents titled "F.I. Request
 * Letter": the Chief Executive's Order authorising the request, the letter
 * itself, and the copy the post brought back. All three scored identically —
 * each contains "Request" and "Letter" — and the tie-break that exists for a
 * second round of questions handed the summary to the returned envelope.
 *
 * Titles are the real ones, read live on 2026-08-21.
 */
describe("findFurtherInfoDocIndex on a file list carrying returned post", () => {
  const MEATH = [
    { title: "Report Received from Internal Staff — Internal Technical Report-Fire Officer's" },
    { title: "F.I. Request Letter — Chief Executive Order" },
    { title: "F.I. Request Letter — Further Information" },
    { title: "F.I. Request Letter — Returned Post-Gone Away" },
    { title: "F.I. Received Doc. — Further Information Received" },
    { title: "F.I. Receipt Ack. Letter — Returned Post-Gone Away" },
  ];

  it("reads the letter the council issued, not the one that came back", () => {
    expect(findFurtherInfoDocIndex(MEATH)).toBe(2);
  });

  it("prefers the letter to the order that authorised it", () => {
    // A Chief Executive's Order directs that further information be sought;
    // the letter is what goes to the applicant and says what is wanted. Both
    // are filed as "F.I. Request Letter", so without this the choice rests on
    // which the register appended last.
    expect(
      findFurtherInfoDocIndex([
        { title: "F.I. Request Letter — Further Information" },
        { title: "F.I. Request Letter — Chief Executive Order" },
      ])
    ).toBe(0);
  });

  it("still reads the order where that is all the council filed", () => {
    // The penalty ranks a document below its siblings; it never rules one
    // out. The order does carry what was asked for, and reading it beats
    // telling the reader there is no request on file.
    expect(findFurtherInfoDocIndex([{ title: "F.I. Request Letter — Chief Executive Order" }])).toBe(
      0
    );
  });

  it("still takes the later of two genuine rounds", () => {
    // The tie-break this fix narrows, not removes: Kildare 25189 was asked in
    // December and again in June, and June is the operative request.
    expect(
      findFurtherInfoDocIndex([
        { title: "F.I. Request Letter — 19/12/2025" },
        { title: "F.I. Request Letter — 16/06/2026" },
      ])
    ).toBe(1);
  });

  it("recognises the ways a register says a letter came back", () => {
    for (const title of [
      "F.I. Request Letter — Returned Post-Gone Away",
      "Notification of Decision Letters — Decision Documentation Returned",
      "F.I. Request Letter — Undelivered",
      "F.I. Request Letter — Not Called For",
    ]) {
      expect(RETURNED_POST_RE.test(title)).toBe(true);
    }
    // And does not fire on wording that merely contains one of the words.
    expect(RETURNED_POST_RE.test("F.I. Request Letter — Further Information")).toBe(false);
  });
});

/**
 * Dublin City PWSDZ4276/23 — Irish Glass Bottle & Fabrizia Sites, Poolbeg
 * West. The further-information panel showed two dates and no summary.
 *
 * Dublin City names nothing "further information". Its request is filed as a
 * "Decision Notice", which is also its name for the actual decision — the only
 * thing separating them is the date. So the matcher now takes the register's
 * own further_info_requested_date, which is a stronger signal than any
 * council's vocabulary and works for all seven.
 *
 * Titles are the real ones, read live on 2026-08-21. The request is index 9
 * here: text extracted from it is dated 04-Oct-2023, carries the form code
 * NOT1adinfo, and reads "the application shall be declared to be withdrawn if
 * the request for FURTHER INFORMATION is not complied with".
 */
describe("findFurtherInfoDocIndex on Dublin City", () => {
  const DUBLIN_CITY = [
    "Managers Order Published — 2024-01-02",
    "Decision Notices — 2023-12-18",
    "Departmental Report Published — 2023-12-18",
    "Planner's Report Published — 2023-12-18",
    "Additional Info Response Correspondence — 2023-11-24",
    "Additional Info Response Maps/drawings — 2023-11-24",
    "Managers Order Published — 2023-10-10",
    "Managers Order Published — 2023-10-06",
    "Managers Order Published — 2023-10-05",
    "Decision Notices — 2023-10-04",
    "Planner's Report Published — 2023-10-04",
    "Comments on application — 2023-09-05",
    "Site Notice — 2023-08-09",
  ].map((title) => ({ title }));

  const REQUESTED = "2023-10-03";

  it("finds the request the council never labelled as one", () => {
    expect(findFurtherInfoDocIndex(DUBLIN_CITY, REQUESTED)).toBe(9);
  });

  it("does not mistake the actual decision for the request", () => {
    // "Decision Notices" is both. Only the date separates them.
    const picked = findFurtherInfoDocIndex(DUBLIN_CITY, REQUESTED);
    expect(DUBLIN_CITY[picked].title).toContain("2023-10-04");
    expect(DUBLIN_CITY[picked].title).not.toContain("2023-12-18");
  });

  it("prefers the letter to the internal order filed days either side", () => {
    // Three Managers Orders sit inside the same window.
    expect(DUBLIN_CITY[findFurtherInfoDocIndex(DUBLIN_CITY, REQUESTED)].title).not.toMatch(
      /Managers Order/
    );
  });

  it("never takes a planner's report, dated the very same day", () => {
    expect(DUBLIN_CITY[findFurtherInfoDocIndex(DUBLIN_CITY, REQUESTED)].title).not.toMatch(
      /Report/i
    );
  });

  it("claims nothing when the register gives no date to go on", () => {
    // Without the date there is no way to tell this council's request from its
    // decision, and guessing would put the wrong letter under the summary.
    expect(findFurtherInfoDocIndex(DUBLIN_CITY, null)).toBe(-1);
  });

  it("ignores a document dated far from the request", () => {
    const far = [{ title: "Decision Notices — 2023-12-18" }];
    expect(findFurtherInfoDocIndex(far, REQUESTED)).toBe(-1);
  });
});

describe("titleDate", () => {
  it("reads the three ways councils write a date", () => {
    expect(titleDate("Decision Notices — 2023-10-04")).toBe("2023-10-04");
    expect(titleDate("Notification of Decision — 11/03/2026")).toBe("2026-03-11");
    expect(titleDate("Notification of Decision — 10.06.2026")).toBe("2026-06-10");
  });

  it("reads day before month, as every Irish register writes it", () => {
    expect(titleDate("F.I. Request Letter — 04/10/2023")).toBe("2023-10-04");
  });

  it("expands a two-digit year", () => {
    expect(titleDate("F.I. Request Letter — 16/06/26")).toBe("2026-06-16");
  });

  it("returns null rather than guessing", () => {
    expect(titleDate("F.I. Request Letter — Further Information")).toBeNull();
    expect(titleDate("Managers Order — 45/13/2023")).toBeNull();
    expect(titleDate(null)).toBeNull();
  });
});
