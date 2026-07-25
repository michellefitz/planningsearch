import { afterEach, describe, expect, it, vi } from "vitest";
import { attrsToSnapshot, fetchLiveNationalSnapshot } from "../../api/accounts/live.mjs";
import { SNAPSHOT_FIELDS } from "../../api/accounts/diff.mjs";

const ATTRS = {
  ApplicationNumber: "SD22A/0440",
  PlanningAuthority: "South Dublin County Council",
  ApplicationStatus: "APPLICATION FINALISED",
  Decision: "GRANT PERMISSION",
  DecisionDate: 1667260800000, // 2022-11-01 UTC
  AppealStatus: null,
  AppealRefNumber: "  ",
  FIRequestDate: null,
  GrantDate: 1672531200000, // 2023-01-01 UTC
};

describe("attrsToSnapshot", () => {
  it("normalizes status, trims blanks to null, converts epoch dates", () => {
    const snap = attrsToSnapshot(ATTRS);
    expect(Object.keys(snap).sort()).toEqual([...SNAPSHOT_FIELDS].sort());
    expect(snap.status).toBe("granted");
    expect(snap.decision).toBe("GRANT PERMISSION");
    expect(snap.decision_date).toBe("2022-11-01");
    expect(snap.final_grant_date).toBe("2023-01-01");
    expect(snap.appeal_reference).toBeNull();
    expect(snap.appeal_status).toBeNull();
    expect(snap.commencement_notice).toBeNull();
  });

  it("withdrawn date forces status to withdrawn", () => {
    const snap = attrsToSnapshot({
      ...ATTRS,
      WithdrawnDate: 1672531200000,
    });
    expect(snap.status).toBe("withdrawn");
  });

  it("decided appeal supersedes council status", () => {
    const snap = attrsToSnapshot({
      ...ATTRS,
      AppealDecision: "REFUSE PERMISSION",
    });
    expect(snap.status).toBe("refused");
    expect(snap.appeal_decision).toBe("REFUSE PERMISSION");
  });

  it("grant date rescues opaque status to granted", () => {
    const snap = attrsToSnapshot({
      ApplicationStatus: "DECISION MADE",
      Decision: null,
      DecisionDate: null,
      AppealStatus: null,
      AppealRefNumber: null,
      AppealDecision: null,
      AppealDecisionDate: null,
      FIRequestDate: null,
      FIRecDate: null,
      GrantDate: 1672531200000,
    });
    expect(snap.status).toBe("granted");
  });
});

describe("fetchLiveNationalSnapshot", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("builds an escaped where clause and maps the first feature", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({ features: [{ attributes: ATTRS }] }),
    }));
    vi.stubGlobal("fetch", fetchMock);
    const snap = await fetchLiveNationalSnapshot("south-dublin", "SD22A/0440");
    expect(snap?.status).toBe("granted");
    const url = String(fetchMock.mock.calls[0][0]);
    expect(url).toContain("FeatureServer/0/query");
    const where = decodeURIComponent(url.split("where=")[1]);
    expect(where).toContain("ApplicationNumber='SD22A/0440'");
    expect(where).toContain("PlanningAuthority LIKE '%South Dublin%'");
  });

  it("escapes single quotes in the reference", async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({ features: [] }) }));
    vi.stubGlobal("fetch", fetchMock);
    await fetchLiveNationalSnapshot("kildare", "O'Brien/22");
    const where = decodeURIComponent(String(fetchMock.mock.calls[0][0]).split("where=")[1]);
    expect(where).toContain("ApplicationNumber='O''Brien/22'");
  });

  it("returns null for unknown authority (no fetch) and empty results", async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({ features: [] }) }));
    vi.stubGlobal("fetch", fetchMock);
    expect(await fetchLiveNationalSnapshot("narnia", "X/1")).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(await fetchLiveNationalSnapshot("kildare", "X/1")).toBeNull();
  });

  it("returns null (not throw) on HTTP error", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 503, text: async () => "down" })));
    expect(await fetchLiveNationalSnapshot("fingal", "F26A/0001")).toBeNull();
  });
});
