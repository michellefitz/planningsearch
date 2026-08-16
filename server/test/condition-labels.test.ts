import { describe, expect, it } from "vitest";
// @ts-expect-error - plain .mjs module shared with the deployed API
import { isGenericTitle, itemLabel, themesFor } from "../../api/_conditions/labels.mjs";

/** The four reasons Dublin City returned for 3005/25 (ABP-322161-25), each
 *  titled "ACP Reason" by the portal — verbatim, lightly trimmed. */
const ACP_REASONS = [
  {
    title: "ACP Reason",
    text:
      "ACP Reason:\n1. Having regard to the design, scale, layout and massing of the proposed houses and the proposed location of a balcony/terrace on the southern boundary of house 1, located within a designated conservation area opposite the River Dodder, it is considered that the proposed development would detract from the character and setting of the conservation area and the Dodder Walk, and would be contrary to Policy BHA9 of the Dublin City Development Plan 2022-2028 which seeks to protect the special interest and character of all of Dublin's conservation areas. The proposed development would result in overlooking and visual overbearance of the adjoining property to the south which would seriously injure the residential amenity of neighbouring residents.",
    order: 1,
  },
  {
    title: "ACP Reason",
    text:
      "ACP Reason:\n2. The site is located entirely within an area zoned Z9 under the Dublin City Development Plan 2022-2028 where the land use objective is 'to preserve, provide and improve recreational amenity, open space and ecosystem services'. The proposed development, which provides for an additional house on a site, is neither a 'permissible' nor 'open for consideration' use within the Z9 zoning, accordingly, the proposed development would be contrary to the Z9 zoning provisions of the development plan and would set an undesirable precedent for similar developments.",
    order: 2,
  },
  {
    title: "ACP Reason",
    text:
      "ACP Reason:\n3. The Commission considered that the applicant has not provided an adequately robust justification for the demolition of the existing cottage and boundary walls which are considered to make a positive contribution to the streetscape within an area of archaeological and industrial heritage interest. The proposed development would be contrary to Policy BHA11 (Rehabilitation and Reuse of Existing Older Buildings) and Policy BHA10 (Demolition in a Conservation Area) of the Dublin City Development Plan 2022-2028.",
    order: 3,
  },
  {
    title: "ACP Reason",
    text:
      "ACP Reason:\n4. The proposed development is in an area which is deemed to be at risk of flooding, by reference to the Dublin City Development Plan 2022-2028 and the documentation on file. Having regard to the provisions of the development plan in relation to development proposals in areas at risk of flooding, it is considered that, in the absence of adequate information relating to the risk of flooding, analysis of such risk, and appropriate mitigation measures to address any risk, the proposed development would be contrary to the proper planning and sustainable development of the area.",
    order: 4,
  },
];

describe("isGenericTitle", () => {
  it("treats the portal's contentless titles as generic", () => {
    for (const t of ["ACP Reason", "Reason", "reason 2", "Condition", "Condition 3", "Note", "", "  "]) {
      expect(isGenericTitle(t), t).toBe(true);
    }
  });

  it("keeps a title the portal actually wrote", () => {
    for (const t of ["Construction hours", "Development contribution", "Materials and finishes"]) {
      expect(isGenericTitle(t), t).toBe(false);
    }
  });
});

describe("themesFor", () => {
  it("names only themes the wording raises", () => {
    expect(themesFor("The proposed development is at risk of flooding.")).toEqual(["Flood risk"]);
    expect(themesFor("Nothing of substance here.")).toEqual([]);
    expect(themesFor("")).toEqual([]);
  });
});

describe("itemLabel", () => {
  it("derives a scannable label for each ACP reason", () => {
    const labels = ACP_REASONS.map((r, i) => itemLabel(r, i + 1));
    expect(labels).toEqual([
      "Conservation area and overlooking",
      "Zoning and precedent",
      "Demolition and conservation area",
      "Flood risk",
    ]);
  });

  it("prefers a real title from the portal over a derived one", () => {
    expect(
      itemLabel({ title: "Construction hours", text: "Work shall be limited to 08:00-18:00." }, 1)
    ).toBe("Construction hours");
  });

  it("falls back to a numbered label when no theme is recognised", () => {
    expect(itemLabel({ title: "Reason", code_label: "Reason", text: "Unclassifiable.", order: 2 }, 2))
      .toBe("Reason 2");
  });
});
