import { describe, expect, it } from "vitest";
import { normalizeStatus as tsNormalizeStatus } from "../src/normalize.js";
import {
  diffSnapshots,
  normalizeStatus,
  SNAPSHOT_FIELDS,
  snapshotFromBundleApp,
} from "../../api/accounts/diff.mjs";

const BASE = Object.fromEntries(SNAPSHOT_FIELDS.map((f) => [f, null]));

describe("normalizeStatus port parity", () => {
  const cases: Array<[string | null, string | null]> = [
    ["GRANT PERMISSION", null],
    ["REFUSED", null],
    ["Registered Application", "GRANT PERMISSION"],
    ["APPLICATION FINALISED", "REFUSE PERMISSION"],
    ["Under Appeal", null],
    ["Further Information Requested", null],
    ["Withdrawn", null],
    ["APPLICATION DECLARED INVA", null],
    ["Split Decision", null],
    ["New Application", null],
    ["Decision Notice Issued", "Declared Exempt"],
    [null, "GRANT PERMISSION"],
    ["", null],
  ];
  for (const [raw, decision] of cases) {
    it(`matches TS for (${raw}, ${decision})`, () => {
      expect(normalizeStatus(raw, decision)).toBe(tsNormalizeStatus(raw, decision));
    });
  }
});

describe("snapshotFromBundleApp", () => {
  it("picks exactly the snapshot fields", () => {
    const app = { id: 7, status: "granted", decision: "GRANT", address_text: "x", commencement_date: "2026-01-01" };
    const snap = snapshotFromBundleApp(app);
    expect(Object.keys(snap).sort()).toEqual([...SNAPSHOT_FIELDS].sort());
    expect(snap.status).toBe("granted");
    expect(snap.commencement_date).toBe("2026-01-01");
    expect((snap as any).id).toBeUndefined();
  });
});

describe("diffSnapshots", () => {
  it("returns [] for first observation and identical snapshots", () => {
    const snap = { ...BASE, status: "pending" };
    expect(diffSnapshots(null, snap)).toEqual([]);
    expect(diffSnapshots(snap, { ...snap })).toEqual([]);
  });

  it("decision issued: emits decision event, suppresses status + decision_date", () => {
    const prev = { ...BASE, status: "pending" };
    const next = { ...BASE, status: "granted", decision: "GRANT PERMISSION", decision_date: "2026-07-01" };
    const events = diffSnapshots(prev, next);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      field: "decision",
      event_type: "decision",
      old_value: null,
      new_value: "GRANT PERMISSION",
      summary: "Decision issued: GRANT PERMISSION",
    });
  });

  it("status-only change keeps the status event with labels", () => {
    const prev = { ...BASE, status: "pending" };
    const next = { ...BASE, status: "further_info" };
    const events = diffSnapshots(prev, next);
    expect(events).toHaveLength(1);
    expect(events[0].summary).toBe("Status changed: Pending decision → Further information");
  });

  it("appeal lodged: reference event suppresses lodged date", () => {
    const prev = { ...BASE, status: "granted" };
    const next = { ...BASE, status: "granted", appeal_reference: "ABP-12345-26", appeal_lodged_date: "2026-06-30" };
    const events = diffSnapshots(prev, next);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      field: "appeal_reference",
      event_type: "appeal",
      summary: "Appeal lodged with An Coimisiún Pleanála (ABP-12345-26)",
    });
  });

  it("commencement notice suppresses commencement date; completion is its own event", () => {
    const prev = { ...BASE, status: "granted" };
    const next = { ...BASE, status: "granted", commencement_notice: "CN-1", commencement_date: "2026-05-01" };
    const events = diffSnapshots(prev, next);
    expect(events).toHaveLength(1);
    expect(events[0].summary).toBe("Commencement notice filed — work is starting");

    const done = diffSnapshots(next, { ...next, completion_date: "2026-07-01" });
    expect(done).toHaveLength(1);
    expect(done[0]).toMatchObject({ event_type: "commencement", summary: "Works recorded complete" });
  });

  it("further info dates map to further_info events", () => {
    const prev = { ...BASE, status: "pending" };
    const events = diffSnapshots(prev, { ...BASE, status: "pending", further_info_requested_date: "2026-07-10" });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ event_type: "further_info", summary: "Further information requested" });
  });

  it("a value disappearing raises no alert — it means a source didn't answer", () => {
    // Previously emitted "appeal status cleared". But nothing in the register
    // un-lodges an appeal or un-files a commencement notice; a field going
    // empty is a portal timeout or a bundle built while BCMS was down. The
    // snapshot still records the new state, we just don't email about it.
    const prev = { ...BASE, status: "granted", appeal_status: "Open" };
    expect(diffSnapshots(prev, { ...BASE, status: "granted" })).toHaveLength(0);
  });

  it("ignores decision rewordings that mean the same outcome", () => {
    // The baseline is national-feed wording; the daily snapshot is the
    // council portal's. "GRANT PERMISSION" and "Grant Permission" are one
    // decision described twice, not a change.
    const prev = { ...BASE, status: "granted", decision: "GRANT PERMISSION" };
    const next = { ...BASE, status: "granted", decision: "Grant Permission" };
    expect(diffSnapshots(prev, next)).toHaveLength(0);
  });

  it("never announces a non-outcome as a decision", () => {
    // Belt and braces behind the pickAgileDecision fix: a portal field holding
    // the decision *maker* must not reach anyone as "Decision issued".
    const prev = { ...BASE, status: "granted", decision: "GRANT PERMISSION" };
    const next = { ...BASE, status: "granted", decision: "Senior Planner West" };
    expect(diffSnapshots(prev, next)).toHaveLength(0);
  });

  it("still reports a genuine change of outcome", () => {
    const prev = { ...BASE, status: "granted", decision: "GRANT PERMISSION" };
    const next = {
      ...BASE,
      status: "split",
      decision: "GRANT PERMISSION AND REFUSE PERMISSION",
    };
    const events = diffSnapshots(prev, next);
    expect(events).toHaveLength(1);
    expect(events[0].summary).toContain("Decision updated");
  });
});
