import { describe, expect, it } from "vitest";
import { buildHarvestQueue } from "../../api/_accounts/harvest.mjs";

/**
 * Why the queue order matters.
 *
 * The nightly agile harvest is time-boxed to 200 seconds at three requests a
 * second, so it reaches a few hundred applications a night out of ~1,500 live
 * ones. Sampled 200 of them against their council portals on 2026-08-21: ten
 * had already been decided while the register still said "pending" — a 5%
 * error rate on the applications people are most likely to be reading. Every
 * one of the ten had a decision due date within eleven days either side of
 * that day.
 *
 * The never-harvested bucket used to drain in full before anything already
 * harvested was refreshed, so a backlog of old references could starve exactly
 * those ten indefinitely.
 */
const NOW = Date.parse("2026-08-21T00:00:00Z");
const day = 86_400_000;
const iso = (offsetDays: number) => new Date(NOW + offsetDays * day).toISOString().slice(0, 10);

const app = (ref: string, over: Record<string, unknown> = {}) => ({
  authority_id: "dublin-city",
  planning_reference: ref,
  status: "pending",
  received_date: "2026-06-01",
  decision_due_date: null,
  ...over,
});
const harvested = (ref: string, fetched: string) => ({
  authority_id: "dublin-city",
  planning_reference: ref,
  agile_id: 1,
  resolve_failed: false,
  fetched_at: fetched,
});
const refs = (q: ReturnType<typeof buildHarvestQueue>) => q.map((i) => i.app.planning_reference);

describe("buildHarvestQueue", () => {
  it("puts an application whose decision is due now ahead of a never-harvested backlog", () => {
    const apps = [
      app("BACKLOG1", { received_date: "2026-08-20" }),
      app("BACKLOG2", { received_date: "2026-08-19" }),
      app("DUE", { decision_due_date: iso(-2) }),
    ];
    const rows = [harvested("DUE", "2026-08-01T00:00:00Z")];
    expect(refs(buildHarvestQueue(apps, rows, NOW))[0]).toBe("DUE");
  });

  it("covers both sides of the due date", () => {
    const apps = [
      app("PASSED", { decision_due_date: iso(-11) }),
      app("SOON", { decision_due_date: iso(11) }),
      app("FILLER", { received_date: "2026-08-20" }),
    ];
    const q = refs(buildHarvestQueue(apps, [], NOW));
    expect(q.slice(0, 2).sort()).toEqual(["PASSED", "SOON"]);
  });

  it("does not treat a long-decided or far-off application as urgent", () => {
    const apps = [
      app("ANCIENT", { decision_due_date: iso(-400) }),
      app("DISTANT", { decision_due_date: iso(200) }),
      app("NODATE"),
    ];
    // All three are never-harvested, so they fall to the fresh bucket and are
    // ordered by received date rather than jumping the queue.
    const q = buildHarvestQueue(apps, [], NOW);
    expect(q).toHaveLength(3);
    expect(refs(q).sort()).toEqual(["ANCIENT", "DISTANT", "NODATE"]);
  });

  it("prefers the never-harvested one when two are both due", () => {
    // A row with no fetch at all is the one most likely to be wrong.
    const apps = [app("SEEN", { decision_due_date: iso(-1) }), app("UNSEEN", { decision_due_date: iso(-1) })];
    const rows = [harvested("SEEN", "2026-08-20T00:00:00Z")];
    expect(refs(buildHarvestQueue(apps, rows, NOW))[0]).toBe("UNSEEN");
  });

  it("does not let a decided application jump the queue", () => {
    /**
     * It is still harvested once, for its description and parties — that is
     * what the fresh bucket is for, and it applies to decided applications
     * too. What it must not do is displace an undecided one whose status is
     * about to change, because its own status will not change again.
     */
    const apps = [
      app("DECIDED", { status: "granted", decision_due_date: iso(-1) }),
      app("DUE", { decision_due_date: iso(-1) }),
    ];
    expect(refs(buildHarvestQueue(apps, [], NOW))).toEqual(["DUE", "DECIDED"]);
  });

  it("stops re-reading an application once it has been decided and harvested", () => {
    const apps = [app("DECIDED", { status: "granted", decision_due_date: iso(-1) })];
    expect(buildHarvestQueue(apps, [harvested("DECIDED", "2026-01-01T00:00:00Z")], NOW)).toEqual([]);
  });

  it("still retries a failed resolution, but last", () => {
    const apps = [app("DUE", { decision_due_date: iso(-1) }), app("BROKEN")];
    const rows = [
      { authority_id: "dublin-city", planning_reference: "BROKEN", agile_id: null, resolve_failed: true, fetched_at: "2026-01-01T00:00:00Z" },
    ];
    expect(refs(buildHarvestQueue(apps, rows, NOW))).toEqual(["DUE", "BROKEN"]);
  });

  it("does not retry a recent failure at all", () => {
    const apps = [app("BROKEN")];
    const rows = [
      { authority_id: "dublin-city", planning_reference: "BROKEN", agile_id: null, resolve_failed: true, fetched_at: "2026-08-20T00:00:00Z" },
    ];
    expect(buildHarvestQueue(apps, rows, NOW)).toEqual([]);
  });

  it("never queues the same application twice", () => {
    const apps = [app("DUE", { decision_due_date: iso(-1) })];
    const q = buildHarvestQueue(apps, [], NOW);
    expect(q).toHaveLength(1);
  });
});
