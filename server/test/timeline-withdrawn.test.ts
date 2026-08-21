import { describe, expect, it } from "vitest";
import { buildTimeline } from "../../web/src/components/DetailPanel.js";
import type { AppDetail } from "../../web/src/api.js";

/**
 * Dublin City WEB2660/26 — withdrawn on 10 August, still reading "Decision due
 * 27 Aug" nine days later.
 *
 * `/enrich` returned `withdrawn` the whole time: the status badge and the
 * submissions panel both read it, and the timeline did not. It was built from
 * the baked register alone, which lags the portal by weeks, so a file that had
 * been closed by the applicant still showed a decision on its way.
 */
const base = {
  status: "pending",
  received_date: "2026-07-01",
  decision_due_date: "2026-08-27",
  decision_date: null,
  decision: null,
  submissions_by_date: null,
  further_info_requested_date: null,
  further_info_received_date: null,
  appeal_lodged_date: null,
  appeal_reference: null,
  appeal_decision: null,
  appeal_status: null,
  commencement_date: null,
} as unknown as AppDetail;

const labels = (steps: ReturnType<typeof buildTimeline>) => steps.map((s) => s.label);
const find = (steps: ReturnType<typeof buildTimeline>, label: string) =>
  steps.find((s) => s.label === label);

describe("timeline on a file that ended without a decision", () => {
  it("stops promising a decision once the portal says withdrawn", () => {
    const steps = buildTimeline(base, null, "withdrawn");
    expect(labels(steps)).not.toContain("Decision due");
    expect(labels(steps)).not.toContain("Decision");
    expect(labels(steps)).toContain("Withdrawn by the applicant");
  });

  it("claims no withdrawal date, because the registers record none", () => {
    // Inventing one would be the same class of error as the stale date it
    // replaces.
    expect(find(buildTimeline(base, null, "withdrawn"), "Withdrawn by the applicant")?.date).toBe(
      null
    );
  });

  it("closes the submissions window with the file", () => {
    // The derived deadline is 5 Aug 2026 — in the future relative to nothing,
    // so without this it renders as an open window on a closed application.
    const open = find(buildTimeline(base, "2099-01-01"), "Submissions by");
    expect(open?.state).toBe("current");
    const closed = find(buildTimeline(base, "2099-01-01", "withdrawn"), "Submissions by");
    expect(closed?.state).toBe("done");
  });

  it("does the same for an invalid application", () => {
    const steps = buildTimeline(base, null, "invalid");
    expect(labels(steps)).toContain("Rejected as invalid");
    expect(labels(steps)).not.toContain("Decision due");
  });

  it("reads the baked status when enrichment has not answered yet", () => {
    // The sheet paints before /enrich returns, so the stale copy still has to
    // be right about a withdrawal the register did catch up on.
    const steps = buildTimeline({ ...base, status: "withdrawn" }, null, null);
    expect(labels(steps)).toContain("Withdrawn by the applicant");
  });

  it("leaves an ordinary pending application alone", () => {
    const steps = buildTimeline(base, null, null);
    expect(labels(steps)).toContain("Decision due");
    expect(find(steps, "Decision due")?.state).toBe("current");
    expect(labels(steps)).not.toContain("Withdrawn by the applicant");
  });

  it("never hides a decision that actually happened", () => {
    /**
     * A register can carry a decision and a portal status of "withdrawn" at
     * the same time — the applicant withdrew after the notice issued. The
     * decision is the fact; it stays.
     */
    const decided = { ...base, decision_date: "2026-08-20", decision: "GRANT PERMISSION" };
    const steps = buildTimeline(decided as AppDetail, null, "withdrawn");
    expect(labels(steps)).toContain("Decided — GRANT PERMISSION");
    expect(labels(steps)).not.toContain("Withdrawn by the applicant");
  });
});
