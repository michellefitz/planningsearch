import { describe, expect, it } from "vitest";
// The helpers live with the UI that renders them; the suite lives here.
import { bcmsNoticeUrl, isRefusalDecision } from "../../web/src/components/DetailPanel.js";

describe("isRefusalDecision", () => {
  it("does not read a grant as a refusal", () => {
    // The bug this guards: DLR D26A/0070/WEB is "GRANT PERMISSION" and carries
    // a code-"R" First Schedule, which used to render as "Reasons for refusal".
    expect(isRefusalDecision("GRANT PERMISSION")).toBe(false);
    expect(isRefusalDecision("GRANT PERMISSION FOR RETENTION")).toBe(false);
    expect(isRefusalDecision("CONDITIONAL PERMISSION")).toBe(false);
  });

  it("catches refusals however the register words them", () => {
    expect(isRefusalDecision("REFUSE PERMISSION")).toBe(true);
    expect(isRefusalDecision("Refused")).toBe(true);
    expect(isRefusalDecision("refusal of permission for retention")).toBe(true);
  });

  it("treats a split decision as a refusal, since real grounds are given", () => {
    expect(isRefusalDecision("GRANT PERMISSION FOR RETENTION AND REFUSE PERMISSION")).toBe(true);
  });

  it("is false for a decision that has not been recorded", () => {
    expect(isRefusalDecision(null)).toBe(false);
    expect(isRefusalDecision(undefined)).toBe(false);
    expect(isRefusalDecision("")).toBe(false);
  });
});

describe("bcmsNoticeUrl", () => {
  it("uses the dataset slug that exists — /dataset/bcms 404s", () => {
    const url = bcmsNoticeUrl("CN0143257DR");
    expect(url).toContain("/dataset/bcnccc/resource/");
    expect(url).not.toContain("/dataset/bcms/");
  });

  it("filters on CN_Number, which the portal honours, not q, which it ignores", () => {
    expect(bcmsNoticeUrl("CN0143257DR")).toBe(
      "https://data.nbco.gov.ie/dataset/bcnccc/resource/0774e781-7af8-46da-b623-872e74cf541e" +
        "?filters=CN_Number%3ACN0143257DR"
    );
  });

  it("points at the same resource the ingest reads, so the row is really there", async () => {
    const { BCMS_RESOURCE_ID } = await import("../src/ingest/bcms.js");
    expect(bcmsNoticeUrl("CN0143257DR")).toContain(BCMS_RESOURCE_ID);
  });
});
