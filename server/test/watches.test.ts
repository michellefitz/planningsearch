import { describe, expect, it } from "vitest";
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — plain .mjs module without type declarations
import { findWatchHits, watchHitSummary } from "../../api/_accounts/watches.mjs";
// @ts-ignore
import { buildDigestEmail } from "../../api/_accounts/digest.mjs";

// Maynooth-ish centre; ~1° lng ≈ 66.5 km at this latitude.
const WATCH = { lat: 53.38, lng: -6.59, radius_m: 1000 };
const SINCE = "2026-06-01";

const app = (over: Record<string, unknown>) => ({
  authority_id: "kildare",
  planning_reference: "26/123",
  address_text: "Main Street",
  lat: 53.38,
  lng: -6.59,
  received_date: "2026-07-01",
  commencement_date: null,
  num_residential_units: null,
  ...over,
});

describe("findWatchHits", () => {
  it("hits a recent application inside the circle", () => {
    const hits = findWatchHits([app({})], WATCH, SINCE);
    expect(hits).toHaveLength(1);
    expect(hits[0].kinds).toEqual(["application"]);
  });

  it("misses outside the radius even when the bbox pre-filter passes", () => {
    // ~1.3 km east: inside the bbox corner, outside the circle.
    expect(findWatchHits([app({ lng: -6.59 + 1300 / 66_500 })], WATCH, SINCE)).toHaveLength(0);
    // ~900 m east: inside.
    expect(findWatchHits([app({ lng: -6.59 + 900 / 66_500 })], WATCH, SINCE)).toHaveLength(1);
  });

  it("skips old activity and missing coordinates", () => {
    expect(findWatchHits([app({ received_date: "2024-01-01" })], WATCH, SINCE)).toHaveLength(0);
    expect(findWatchHits([app({ lat: null, lng: null })], WATCH, SINCE)).toHaveLength(0);
  });

  it("reports a recent commencement on an old application as commencement only", () => {
    const hits = findWatchHits(
      [app({ received_date: "2023-05-01", commencement_date: "2026-07-10" })],
      WATCH,
      SINCE
    );
    expect(hits[0].kinds).toEqual(["commencement"]);
  });
});

describe("watchHitSummary", () => {
  it("distinguishes council, ACP and commencement items, with size when large", () => {
    expect(watchHitSummary(app({}), "application")).toBe("New planning application");
    expect(watchHitSummary(app({ num_residential_units: 250 }), "application")).toBe(
      "New planning application (250 homes)"
    );
    expect(watchHitSummary(app({ authority_id: "acp" }), "application")).toContain(
      "An Coimisiún Pleanála"
    );
    expect(watchHitSummary(app({}), "commencement")).toContain("commenced");
  });
});

describe("buildDigestEmail with area sections", () => {
  const area = {
    name: "Home",
    items: [
      {
        address: "Main Street",
        reference: "26/123",
        summary: "New planning application",
        url: "https://example.test/#app=kildare:26%2F123",
      },
    ],
  };

  it("sends an area-only digest with an area subject", () => {
    const mail = buildDigestEmail([], null, [area]);
    expect(mail.subject).toBe("New planning activity in Home");
    expect(mail.html).toContain("In Home");
    expect(mail.text).toContain("New planning application: Main Street (26/123)");
  });

  it("keeps the saved-app subject when both kinds are present", () => {
    const entry = { address: "1 High St", reference: "26/1", url: "u", summaries: ["Decision made"] };
    const mail = buildDigestEmail([entry], null, [area]);
    expect(mail.subject).toBe("Update on 1 High St");
    expect(mail.html).toContain("In Home");
  });

  it("stays backward-compatible without area sections", () => {
    const entry = { address: "1 High St", reference: "26/1", url: "u", summaries: ["Decision made"] };
    const mail = buildDigestEmail([entry], null);
    expect(mail.subject).toBe("Update on 1 High St");
  });
});
