import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, type AppDetail, type AppSummary, type Authority, type Meta } from "../api";
import { STATUS_STYLE } from "./MapView";

const DetailPanel = lazy(() => import("./DetailPanel"));

const MAX_EXAMPLES = 5;

interface Scenario {
  id: string;
  label: string;
  color: string;
  letter: string;
  group: "status" | "compound";
  searchParams: (authorityId: string) => URLSearchParams;
  match?: (detail: AppDetail) => boolean;
}

const BASE_STATUSES: Scenario[] = Object.entries(STATUS_STYLE).map(([key, s]) => ({
  id: key,
  label: s.label,
  color: s.color,
  letter: s.letter,
  group: "status",
  searchParams: (authorityId: string) =>
    new URLSearchParams({ status: key, authority: authorityId, sort: "received", limit: String(MAX_EXAMPLES) }),
}));

const COMPOUND_SCENARIOS: Scenario[] = [
  {
    id: "granted_no_appeal",
    label: "Granted (no appeal)",
    color: "#16a34a",
    letter: "G",
    group: "compound",
    searchParams: (authorityId: string) =>
      new URLSearchParams({ status: "granted", authority: authorityId, sort: "received", limit: "20" }),
    match: (d) => !d.appeal_reference,
  },
  {
    id: "granted_appealed",
    label: "Granted → appealed",
    color: "#ea580c",
    letter: "GA",
    group: "compound",
    searchParams: (authorityId: string) =>
      new URLSearchParams({ status: "granted", authority: authorityId, appealed: "1", sort: "received", limit: "20" }),
    match: (d) => !!d.appeal_reference,
  },
  {
    id: "granted_appeal_overturned",
    label: "Council refused → granted on appeal",
    color: "#16a34a",
    letter: "↑G",
    group: "compound",
    searchParams: (authorityId: string) =>
      new URLSearchParams({ status: "granted", authority: authorityId, appealed: "1", sort: "received", limit: "20" }),
    match: (d) =>
      !!d.appeal_reference &&
      !!d.decision &&
      /refus/i.test(d.decision),
  },
  {
    id: "refused_no_appeal",
    label: "Refused (no appeal)",
    color: "#dc2626",
    letter: "R",
    group: "compound",
    searchParams: (authorityId: string) =>
      new URLSearchParams({ status: "refused", authority: authorityId, sort: "received", limit: "20" }),
    match: (d) => !d.appeal_reference,
  },
  {
    id: "refused_appealed",
    label: "Refused → appealed",
    color: "#ea580c",
    letter: "RA",
    group: "compound",
    searchParams: (authorityId: string) =>
      new URLSearchParams({ status: "refused", authority: authorityId, appealed: "1", sort: "received", limit: "20" }),
    match: (d) => !!d.appeal_reference,
  },
  {
    id: "refused_appeal_upheld",
    label: "Refused → appeal upheld",
    color: "#dc2626",
    letter: "↓R",
    group: "compound",
    searchParams: (authorityId: string) =>
      new URLSearchParams({ status: "refused", authority: authorityId, appealed: "1", sort: "received", limit: "20" }),
    match: (d) =>
      !!d.appeal_reference &&
      !!d.appeal_decision &&
      /refus/i.test(d.appeal_decision),
  },
  /**
   * The shape almost every recent bug had, and the one the grid could not
   * reach: an application that went out for further information.
   *
   * It is not the same as the "further information" status — that is the
   * council still waiting. A *decided* application that was asked for more
   * renders a Further information section as well as a Decision, and that
   * pairing is where the faults were: Dublin City rendered the whole decision
   * under Further information (#53), DLR repeated the request as
   * "Clarifications & informatives" (#53), South Dublin showed no request at
   * all (#54), and Meath read a letter that had come back undelivered (#58).
   *
   * The register's date is the signal and there is no query filter for it, so
   * it is matched on the detail. Sorted by decision rather than by receipt:
   * newest-first returns applications too recent to have been through the
   * cycle, and the grid came back empty on six councils out of seven.
   */
  {
    id: "decided_after_fi",
    label: "Decided after further information",
    color: "#7c3aed",
    letter: "FI+",
    group: "compound",
    searchParams: (authorityId: string) =>
      new URLSearchParams({
        status: "granted",
        authority: authorityId,
        sort: "decision",
        limit: "40",
      }),
    match: (d) => !!d.further_info_requested_date && !!d.decision,
  },
  {
    id: "fi_awaiting_response",
    label: "Further information requested, undecided",
    color: "#7c3aed",
    letter: "FI?",
    group: "compound",
    searchParams: (authorityId: string) =>
      new URLSearchParams({
        status: "further_info",
        authority: authorityId,
        sort: "received",
        limit: String(MAX_EXAMPLES),
      }),
    // South Dublin's conditions endpoint answers nothing until a decision
    // issues, so this column is where a council that publishes the request
    // only as a letter shows up.
    match: (d) => !!d.further_info_requested_date && !d.decision,
  },
  {
    id: "appealed_pending",
    label: "Under appeal (pending)",
    color: "#ea580c",
    letter: "A",
    group: "compound",
    searchParams: (authorityId: string) =>
      new URLSearchParams({ status: "appealed", authority: authorityId, sort: "received", limit: String(MAX_EXAMPLES) }),
  },
];

const ALL_SCENARIOS = [...BASE_STATUSES, ...COMPOUND_SCENARIOS];

type CellState =
  | { phase: "idle" }
  | { phase: "loading" }
  | { phase: "empty" }
  | { phase: "loaded"; details: AppDetail[] };

export default function QaPage() {
  const [meta, setMeta] = useState<Meta | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [cells, setCells] = useState<Record<string, CellState>>({});
  const [activeIndexes, setActiveIndexes] = useState<Record<string, number>>({});
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    api.meta().then(setMeta).catch(console.error);
  }, []);

  const authorities = useMemo(() => meta?.authorities ?? [], [meta]);

  const cellKey = (scenarioId: string, authorityId: string) => `${scenarioId}:${authorityId}`;

  const selectScenario = useCallback(
    (scenarioId: string) => {
      if (selectedId === scenarioId) {
        setSelectedId(null);
        return;
      }
      setSelectedId(scenarioId);

      const scenario = ALL_SCENARIOS.find((s) => s.id === scenarioId);
      if (!scenario) return;

      abortRef.current?.abort();
      const ctrl = new AbortController();
      abortRef.current = ctrl;

      for (const auth of authorities) {
        const key = cellKey(scenarioId, auth.id);
        if (cells[key]?.phase === "loaded" || cells[key]?.phase === "empty") continue;

        setCells((prev) => ({ ...prev, [key]: { phase: "loading" } }));

        const params = scenario.searchParams(auth.id);

        api
          .search(params)
          .then(async (res) => {
            if (ctrl.signal.aborted) return;
            if (!res.results.length) {
              setCells((prev) => ({ ...prev, [key]: { phase: "empty" } }));
              return;
            }

            const matched: AppDetail[] = [];
            for (const result of res.results) {
              if (ctrl.signal.aborted) return;
              if (matched.length >= MAX_EXAMPLES) break;
              const detail = await api.detail(result.id);
              if (ctrl.signal.aborted) return;
              if (!scenario.match || scenario.match(detail)) {
                matched.push(detail);
                setCells((prev) => ({
                  ...prev,
                  [key]: { phase: "loaded", details: [...matched] },
                }));
              }
            }
            if (matched.length === 0) {
              setCells((prev) => ({ ...prev, [key]: { phase: "empty" } }));
            }
          })
          .catch(() => {
            if (!ctrl.signal.aborted) {
              setCells((prev) => ({ ...prev, [key]: { phase: "empty" } }));
            }
          });
      }
    },
    [selectedId, authorities, cells]
  );

  const selected = ALL_SCENARIOS.find((s) => s.id === selectedId) ?? null;

  const activePanels = useMemo(() => {
    if (!selectedId) return [];
    return authorities
      .map((auth) => {
        const cell = cells[cellKey(selectedId, auth.id)];
        if (cell?.phase !== "loaded" || cell.details.length === 0) return null;
        const idx = activeIndexes[auth.id] ?? 0;
        const detail = cell.details[Math.min(idx, cell.details.length - 1)];
        return { authority: auth, detail, total: cell.details.length };
      })
      .filter(Boolean) as Array<{ authority: Authority; detail: AppDetail; total: number }>;
  }, [selectedId, authorities, cells, activeIndexes]);

  const cycleExample = (authorityId: string, delta: number) => {
    setActiveIndexes((prev) => {
      const key = cellKey(selectedId!, authorityId);
      const cell = cells[key];
      if (cell?.phase !== "loaded") return prev;
      const max = cell.details.length;
      const cur = prev[authorityId] ?? 0;
      const next = (cur + delta + max) % max;
      return { ...prev, [authorityId]: next };
    });
  };

  useEffect(() => {
    setActiveIndexes({});
  }, [selectedId]);

  if (!meta) {
    return (
      <div style={{ padding: 40, fontFamily: "system-ui", color: "#64748b" }}>Loading…</div>
    );
  }

  const renderRow = (scenario: Scenario) => {
    const isSelected = selectedId === scenario.id;
    return (
      <tr
        key={scenario.id}
        onClick={() => selectScenario(scenario.id)}
        style={{
          cursor: "pointer",
          background: isSelected ? `${scenario.color}08` : undefined,
          borderLeft: isSelected ? `3px solid ${scenario.color}` : "3px solid transparent",
        }}
      >
        <td
          style={{
            padding: "10px 14px",
            fontWeight: 500,
            color: scenario.color,
            borderBottom: "1px solid #f1f5f9",
            position: "sticky",
            left: 0,
            background: isSelected ? `${scenario.color}08` : "#fff",
            zIndex: 1,
            display: "flex",
            alignItems: "center",
            gap: 8,
          }}
        >
          <span
            style={{
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              width: 22,
              height: 22,
              borderRadius: "50%",
              background: scenario.color,
              color: "#fff",
              fontSize: scenario.letter.length > 1 ? 8 : 11,
              fontWeight: 700,
              flexShrink: 0,
            }}
          >
            {scenario.letter}
          </span>
          {scenario.label}
        </td>
        {authorities.map((a) => {
          const key = cellKey(scenario.id, a.id);
          const cell = cells[key];
          return (
            <td
              key={a.id}
              style={{
                padding: "10px 14px",
                textAlign: "center",
                borderBottom: "1px solid #f1f5f9",
                color: "#94a3b8",
              }}
            >
              {cell?.phase === "loading" && <span>…</span>}
              {cell?.phase === "loaded" && (
                <span
                  style={{ color: scenario.color, fontWeight: 600, fontSize: 16 }}
                  title={`${cell.details.length} example${cell.details.length !== 1 ? "s" : ""}`}
                >
                  {cell.details.length > 1 ? cell.details.length : "●"}
                </span>
              )}
              {cell?.phase === "empty" && (
                <span style={{ color: "#e2e8f0" }} title="No example found">—</span>
              )}
              {(!cell || cell.phase === "idle") && <span style={{ color: "#e2e8f0" }}>·</span>}
            </td>
          );
        })}
      </tr>
    );
  };

  return (
    <div style={{ fontFamily: "system-ui", minHeight: "100vh", background: "#f8fafc" }}>
      <div
        style={{
          padding: "16px 24px",
          borderBottom: "1px solid #e2e8f0",
          background: "#fff",
          display: "flex",
          alignItems: "center",
          gap: 12,
        }}
      >
        <a href="/" style={{ color: "#64748b", textDecoration: "none", fontSize: 14 }}>
          ← Back
        </a>
        <h1 style={{ margin: 0, fontSize: 18, fontWeight: 600, color: "#0f172a" }}>
          State Machine — QA
        </h1>
        <span style={{ color: "#94a3b8", fontSize: 13 }}>
          {authorities.length} councils · {ALL_SCENARIOS.length} scenarios · up to {MAX_EXAMPLES} examples each
        </span>
      </div>

      <div style={{ padding: "20px 24px", overflowX: "auto" }}>
        <table
          style={{
            borderCollapse: "collapse",
            fontSize: 13,
            width: "100%",
            background: "#fff",
            borderRadius: 8,
            overflow: "hidden",
            boxShadow: "0 1px 3px rgba(0,0,0,0.08)",
          }}
        >
          <thead>
            <tr style={{ background: "#f1f5f9" }}>
              <th
                style={{
                  padding: "10px 14px",
                  textAlign: "left",
                  fontWeight: 600,
                  color: "#475569",
                  borderBottom: "1px solid #e2e8f0",
                  position: "sticky",
                  left: 0,
                  background: "#f1f5f9",
                  zIndex: 1,
                  minWidth: 200,
                }}
              >
                Scenario
              </th>
              {authorities.map((a) => (
                <th
                  key={a.id}
                  style={{
                    padding: "10px 14px",
                    textAlign: "center",
                    fontWeight: 500,
                    color: "#475569",
                    borderBottom: "1px solid #e2e8f0",
                    whiteSpace: "nowrap",
                    minWidth: 100,
                  }}
                >
                  {a.short_name}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            <tr>
              <td
                colSpan={authorities.length + 1}
                style={{
                  padding: "8px 14px 4px",
                  fontSize: 10,
                  fontWeight: 700,
                  textTransform: "uppercase",
                  letterSpacing: "0.05em",
                  color: "#94a3b8",
                  background: "#fafbfc",
                  borderBottom: "1px solid #f1f5f9",
                }}
              >
                Base statuses
              </td>
            </tr>
            {BASE_STATUSES.map(renderRow)}
            <tr>
              <td
                colSpan={authorities.length + 1}
                style={{
                  padding: "12px 14px 4px",
                  fontSize: 10,
                  fontWeight: 700,
                  textTransform: "uppercase",
                  letterSpacing: "0.05em",
                  color: "#94a3b8",
                  background: "#fafbfc",
                  borderBottom: "1px solid #f1f5f9",
                }}
              >
                Appeal &amp; decision scenarios
              </td>
            </tr>
            {COMPOUND_SCENARIOS.map(renderRow)}
          </tbody>
        </table>
      </div>

      {selected && (
        <div style={{ padding: "0 24px 40px" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 16 }}>
            <span
              style={{
                display: "inline-flex",
                alignItems: "center",
                justifyContent: "center",
                width: 26,
                height: 26,
                borderRadius: "50%",
                background: selected.color,
                color: "#fff",
                fontSize: selected.letter.length > 1 ? 9 : 12,
                fontWeight: 700,
              }}
            >
              {selected.letter}
            </span>
            <h2 style={{ margin: 0, fontSize: 16, fontWeight: 600, color: "#0f172a" }}>
              {selected.label}
            </h2>
            <span style={{ color: "#94a3b8", fontSize: 13 }}>
              — {activePanels.length} council{activePanels.length !== 1 ? "s" : ""} with examples
              {authorities.some(
                (a) => cells[cellKey(selected.id, a.id)]?.phase === "loading"
              ) && ", loading more…"}
            </span>
          </div>

          {activePanels.length === 0 &&
            !authorities.some(
              (a) => cells[cellKey(selected.id, a.id)]?.phase === "loading"
            ) && (
              <div style={{ color: "#94a3b8", fontSize: 14, padding: "20px 0" }}>
                No examples found for this scenario across any council.
              </div>
            )}

          <div
            style={{
              display: "grid",
              gridTemplateColumns: `repeat(${Math.min(activePanels.length, 3)}, 1fr)`,
              gap: 16,
              alignItems: "start",
            }}
          >
            <Suspense fallback={null}>
              {activePanels.map(({ authority, detail, total }) => {
                const idx = activeIndexes[authority.id] ?? 0;
                return (
                  <div
                    key={authority.id}
                    style={{
                      border: "1px solid #e2e8f0",
                      borderRadius: 10,
                      overflow: "hidden",
                      background: "#fff",
                      maxHeight: "120vh",
                      overflowY: "auto",
                    }}
                  >
                    <div
                      style={{
                        padding: "8px 14px",
                        background: "#f8fafc",
                        borderBottom: "1px solid #e2e8f0",
                        fontSize: 12,
                        color: "#475569",
                        position: "sticky",
                        top: 0,
                        zIndex: 2,
                      }}
                    >
                      <div
                        style={{
                          display: "flex",
                          justifyContent: "space-between",
                          alignItems: "center",
                          fontWeight: 600,
                        }}
                      >
                        <span>{authority.name}</span>
                        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                          {total > 1 && (
                            <>
                              <button
                                onClick={(e) => { e.stopPropagation(); cycleExample(authority.id, -1); }}
                                style={{
                                  border: "1px solid #e2e8f0",
                                  background: "#fff",
                                  borderRadius: 4,
                                  width: 22,
                                  height: 22,
                                  cursor: "pointer",
                                  display: "inline-grid",
                                  placeItems: "center",
                                  fontSize: 11,
                                  color: "#64748b",
                                }}
                              >
                                ‹
                              </button>
                              <span style={{ fontSize: 11, color: "#94a3b8", minWidth: 30, textAlign: "center" }}>
                                {idx + 1}/{total}
                              </span>
                              <button
                                onClick={(e) => { e.stopPropagation(); cycleExample(authority.id, 1); }}
                                style={{
                                  border: "1px solid #e2e8f0",
                                  background: "#fff",
                                  borderRadius: 4,
                                  width: 22,
                                  height: 22,
                                  cursor: "pointer",
                                  display: "inline-grid",
                                  placeItems: "center",
                                  fontSize: 11,
                                  color: "#64748b",
                                }}
                              >
                                ›
                              </button>
                            </>
                          )}
                        </div>
                      </div>
                      <div style={{ marginTop: 3, color: "#94a3b8", fontSize: 11 }}>
                        <span style={{ color: "#64748b" }}>{detail.planning_reference}</span>
                        {detail.status_raw && (
                          <>
                            {" · "}
                            <code style={{ background: "#f1f5f9", padding: "1px 4px", borderRadius: 3 }}>{detail.status_raw}</code>
                            {" → "}
                            <code style={{ background: "#f1f5f9", padding: "1px 4px", borderRadius: 3 }}>{detail.status}</code>
                          </>
                        )}
                        {detail.appeal_reference && (
                          <>
                            {" · appeal "}
                            <code style={{ background: "#fef3c7", padding: "1px 4px", borderRadius: 3 }}>{detail.appeal_reference}</code>
                            {detail.appeal_decision && (
                              <> → <code style={{ background: "#f1f5f9", padding: "1px 4px", borderRadius: 3 }}>{detail.appeal_decision}</code></>
                            )}
                          </>
                        )}
                        {" · "}
                        {authority.source_system}
                      </div>
                    </div>
                    <div className="qa-panel-embed">
                      <DetailPanel
                        detail={detail}
                        meta={meta}
                        onClose={() => {}}
                        onSelectRelated={() => {}}
                        saved={false}
                        onToggleSave={() => {}}
                      />
                    </div>
                  </div>
                );
              })}
            </Suspense>
          </div>
        </div>
      )}
    </div>
  );
}
