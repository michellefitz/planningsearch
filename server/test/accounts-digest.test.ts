import { describe, expect, it } from "vitest";
import { buildDigestEmail } from "../../api/accounts/digest.mjs";

const ENTRY = {
  address: "12 Main Street, Maynooth",
  reference: "KE26/0123",
  url: "https://planview.test/#app=kildare:KE26%2F0123",
  summaries: ["Decision issued: GRANT PERMISSION"],
};

describe("buildDigestEmail", () => {
  it("single entry: subject names the property", () => {
    const { subject } = buildDigestEmail([ENTRY]);
    expect(subject).toBe("Update on 12 Main Street, Maynooth");
  });

  it("multiple entries: subject counts them", () => {
    const two = [ENTRY, { ...ENTRY, address: "Other House", reference: "F26A/1" }];
    expect(buildDigestEmail(two).subject).toBe("Updates on 2 applications you're watching");
  });

  it("text body carries address, reference, every summary and the link", () => {
    const entry = { ...ENTRY, summaries: ["Decision issued: GRANT PERMISSION", "Final grant issued"] };
    const { text } = buildDigestEmail([entry]);
    expect(text).toContain("12 Main Street, Maynooth");
    expect(text).toContain("KE26/0123");
    expect(text).toContain("Decision issued: GRANT PERMISSION");
    expect(text).toContain("Final grant issued");
    expect(text).toContain(ENTRY.url);
  });

  it("html body carries address, summaries and the link", () => {
    const { html } = buildDigestEmail([ENTRY]);
    expect(html).toContain("12 Main Street, Maynooth");
    expect(html).toContain("Decision issued: GRANT PERMISSION");
    expect(html).toContain(ENTRY.url);
    expect(html).toContain("PlanView");
  });
});
