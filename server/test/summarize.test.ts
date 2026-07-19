import { describe, expect, it } from "vitest";
import { isUsableSummary } from "../src/summarize.js";

describe("isUsableSummary", () => {
  it("keeps a genuine plain-English summary", () => {
    const s = "A three-storey block of 111 apartments with basement parking on a 0.79 ha site.";
    expect(isUsableSummary(s)).toBe(s);
    expect(isUsableSummary("Refused because the block would overlook neighbouring gardens.")).toBe(
      "Refused because the block would overlook neighbouring gardens."
    );
  });

  it("rejects the INSUFFICIENT sentinel", () => {
    expect(isUsableSummary("INSUFFICIENT")).toBeNull();
    expect(isUsableSummary("Insufficient.")).toBeNull();
    expect(isUsableSummary("  insufficient  ")).toBeNull();
  });

  it("rejects conversational refusals / prompt leaks", () => {
    expect(
      isUsableSummary(
        "I don't have enough information to summarize this application. The description appears incomplete — could you provide the full description?"
      )
    ).toBeNull();
    expect(isUsableSummary("I'm unable to determine what is being built here.")).toBeNull();
    expect(isUsableSummary("As an AI, I cannot summarise this.")).toBeNull();
    expect(isUsableSummary("Please provide more detail about the proposal.")).toBeNull();
  });

  it("treats empty / null input as unusable", () => {
    expect(isUsableSummary(null)).toBeNull();
    expect(isUsableSummary("   ")).toBeNull();
  });
});
