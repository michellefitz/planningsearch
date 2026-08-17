import { describe, expect, it } from "vitest";
import {
  developmentContribution,
  payableAmounts,
} from "../../api/_conditions/contribution.mjs";

describe("developmentContribution", () => {
  // Every fixture below is real register wording.
  const dlr = [
    { code: "C", order: 6, text: "Countywide Surface Water\n6. The Developer shall, prior to commencement, pay the sum of €51.60 to the Planning Authority as a contribution towards expenditure." },
    { code: "C", order: 7, text: "Countywide Transport Infrastructure\n7. The Developer shall pay the sum of €773.14 to the Planning Authority as a contribution towards expenditure." },
    { code: "C", order: 8, text: "Countywide Community & Parks\n8. The Developer shall pay the sum of €4,328.38 to the Planning Authority as a contribution towards expenditure." },
  ];

  it("totals the parts councils split it across (DLR D26A/0070/WEB)", () => {
    expect(developmentContribution(dlr)).toEqual({ total: 5153.12, condition: 6 });
  });

  it("cites the first contribution condition, so the link lands somewhere real", () => {
    expect(developmentContribution(dlr)?.condition).toBe(6);
  });

  it("sums several clauses inside one lumped condition (DLR D23B/0599)", () => {
    // Some DLR records arrive with every condition concatenated into one item;
    // one figure per condition charged €4.97 against a real bill of €497.15.
    const lumped = [
      {
        code: "C",
        order: 1,
        text:
          "4. The Developer shall pay the sum of €4.97 as a contribution towards expenditure. REASON: public health. " +
          "5. The Developer shall pay the sum of €74.58 as a contribution towards expenditure. REASON: orderly development. " +
          "6. The Developer shall pay the sum of €417.60 as a contribution towards expenditure.",
      },
    ];
    expect(developmentContribution(lumped)?.total).toBeCloseTo(497.15, 2);
  });

  it("takes the amended figure, not the superseded one (SD26A/0084W)", () => {
    // Charging the original here would overstate the bill by €133,742.88.
    const amended = [
      {
        code: "C",
        order: 18,
        text:
          "Financial Contribution. The developer shall pay a financial contribution of €222,068.16 in respect of public infrastructure. REASON: reasonable. " +
          "Condition 18 was amended by PR/0805/26 on 17/07/2026: Financial Contribution. The developer shall pay a financial contribution of €88,325.28 in respect of public infrastructure.",
      },
    ];
    expect(developmentContribution(amended)).toEqual({ total: 88325.28, condition: 18 });
  });

  it("ignores a passing reference to the contribution scheme with no figure", () => {
    expect(
      developmentContribution([
        { code: "C", order: 1, text: "…in accordance with the Development Contribution Scheme 2023-2028 made by the Council." },
      ])
    ).toBeNull();
  });

  it("is null when the council asked for no money", () => {
    expect(developmentContribution([{ code: "C", order: 1, text: "Build per the plans." }])).toBeNull();
  });

  it("reads cents and thousands separators the registers actually use", () => {
    expect(payableAmounts("pay the sum of €76,383 to the Authority")).toEqual([76383]);
    expect(payableAmounts("a financial contribution of €28.92 (twenty eight euros)")).toEqual([28.92]);
    expect(payableAmounts("no money here")).toEqual([]);
  });
});
