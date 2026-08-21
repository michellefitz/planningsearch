import { describe, expect, it } from "vitest";
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — plain .mjs module without type declarations
import {
  DEFAULT_WATCH_KINDS,
  WATCH_KIND_IDS,
  findWatchHits,
  normaliseWatchKinds,
  watchHitSummary,
} from "../../api/_accounts/watches.mjs";
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

/**
 * Choosing what a watch alerts on.
 *
 * Before this a watch alerted on new applications and commencement notices and
 * said neither — the dashboard offered "everything" without saying what
 * everything was. The kind strings are deliberately the ones already written
 * into area_watch_alerted: renaming "application" or "commencement" would make
 * every previously alerted row stop matching and re-send the lot.
 */
const decided = (over: Record<string, unknown> = {}) =>
  app({ decision_date: "2026-07-10", decision: "GRANT PERMISSION", received_date: null, ...over });

describe("watch kinds", () => {
  it("keeps an old watch alerting on exactly what it always did", () => {
    // Null kinds is a row written before the choice existed. Changing what it
    // alerts on, in either direction, is worse than the missing feature was.
    const old = { ...WATCH, kinds: null };
    expect(findWatchHits([app({})], old, SINCE)[0].kinds).toEqual(["application"]);
    expect(findWatchHits([decided()], old, SINCE)).toEqual([]);
  });

  it("alerts on a decision when the watch asked for one", () => {
    const w = { ...WATCH, kinds: ["decision"] };
    const hits = findWatchHits([decided()], w, SINCE);
    expect(hits[0].kinds).toEqual(["decision"]);
  });

  it("stays quiet about a new application when the watch did not ask", () => {
    const w = { ...WATCH, kinds: ["decision"] };
    expect(findWatchHits([app({})], w, SINCE)).toEqual([]);
  });

  it("reports several kinds on one application", () => {
    // A file can be received, decided and started inside the same window.
    const busy = app({ decision_date: "2026-07-10", decision: "GRANT PERMISSION", commencement_date: "2026-07-20" });
    const w = { ...WATCH, kinds: [...WATCH_KIND_IDS] };
    expect(findWatchHits([busy], w, SINCE)[0].kinds).toEqual([
      "application",
      "decision",
      "commencement",
    ]);
  });

  it("alerts on an appeal", () => {
    const appealed = app({
      received_date: null,
      appeal_lodged_date: "2026-07-05",
      appeal_reference: "ABP-123456-26",
    });
    const w = { ...WATCH, kinds: ["appeal"] };
    expect(findWatchHits([appealed], w, SINCE)[0].kinds).toEqual(["appeal"]);
  });

  it("still respects the recency window and the circle", () => {
    const w = { ...WATCH, kinds: ["decision"] };
    expect(findWatchHits([decided({ decision_date: "2020-01-01" })], w, SINCE)).toEqual([]);
    // ~3 km east of the centre, well outside a 1 km radius.
    expect(findWatchHits([decided({ lng: -6.545 })], w, SINCE)).toEqual([]);
  });
});

describe("normaliseWatchKinds", () => {
  it("keeps a stable order whatever order they arrive in", () => {
    expect(normaliseWatchKinds(["commencement", "application"])).toEqual([
      "application",
      "commencement",
    ]);
  });

  it("drops anything it does not recognise, and de-duplicates", () => {
    expect(normaliseWatchKinds(["decision", "decision", "nonsense"])).toEqual(["decision"]);
  });

  it("returns null when nothing usable was asked for", () => {
    // The caller decides what null means: a default on create, an error on edit.
    expect(normaliseWatchKinds([])).toBeNull();
    expect(normaliseWatchKinds(["nonsense"])).toBeNull();
    expect(normaliseWatchKinds(null)).toBeNull();
    expect(normaliseWatchKinds("decision")).toBeNull();
  });

  it("defaults to what the feature did before it was a choice", () => {
    expect([...DEFAULT_WATCH_KINDS]).toEqual(["application", "commencement"]);
  });
});

describe("watchHitSummary for the new kinds", () => {
  it("never lets a grant and a refusal read the same", () => {
    expect(watchHitSummary(decided(), "decision")).toContain("GRANT PERMISSION");
    expect(watchHitSummary(decided({ decision: "REFUSE PERMISSION" }), "decision")).toContain(
      "REFUSE PERMISSION"
    );
  });

  it("says something useful when the register recorded no wording", () => {
    expect(watchHitSummary(decided({ decision: null }), "decision")).toBe("A decision has issued");
  });

  it("names the appeal case where there is one", () => {
    expect(watchHitSummary(app({ appeal_reference: "ABP-123456-26" }), "appeal")).toContain(
      "ABP-123456-26"
    );
  });
});
