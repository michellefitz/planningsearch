import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, type AppDetail, type AppSummary, type Authority, type Meta } from "../api";
import { STATUS_STYLE } from "./MapView";

const DetailPanel = lazy(() => import("./DetailPanel"));

const ALL_STATUSES = Object.keys(STATUS_STYLE);

type CellState =
  | { phase: "idle" }
  | { phase: "loading" }
  | { phase: "empty" }
  | { phase: "loaded"; summary: AppSummary; detail: AppDetail };

export default function QaPage() {
  const [meta, setMeta] = useState<Meta | null>(null);
  const [selectedStatus, setSelectedStatus] = useState<string | null>(null);
  const [cells, setCells] = useState<Record<string, CellState>>({});
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    api.meta().then(setMeta).catch(console.error);
  }, []);

  const authorities = useMemo(
    () => meta?.authorities ?? [],
    [meta]
  );

  const cellKey = (status: string, authorityId: string) => `${status}:${authorityId}`;

  const selectStatus = useCallback(
    (status: string) => {
      if (selectedStatus === status) {
        setSelectedStatus(null);
        return;
      }
      setSelectedStatus(status);

      abortRef.current?.abort();
      const ctrl = new AbortController();
      abortRef.current = ctrl;

      for (const auth of authorities) {
        const key = cellKey(status, auth.id);
        if (cells[key]?.phase === "loaded" || cells[key]?.phase === "empty") continue;

        setCells((prev) => ({ ...prev, [key]: { phase: "loading" } }));

        const params = new URLSearchParams({
          status,
          authority: auth.id,
          sort: "received",
          limit: "1",
        });

        api
          .search(params)
          .then(async (res) => {
            if (ctrl.signal.aborted) return;
            if (!res.results.length) {
              setCells((prev) => ({ ...prev, [key]: { phase: "empty" } }));
              return;
            }
            const summary = res.results[0];
            const detail = await api.detail(summary.id);
            if (ctrl.signal.aborted) return;
            setCells((prev) => ({
              ...prev,
              [key]: { phase: "loaded", summary, detail },
            }));
          })
          .catch(() => {
            if (!ctrl.signal.aborted) {
              setCells((prev) => ({ ...prev, [key]: { phase: "empty" } }));
            }
          });
      }
    },
    [selectedStatus, authorities, cells]
  );

  const activePanels = useMemo(() => {
    if (!selectedStatus) return [];
    return authorities
      .map((auth) => {
        const cell = cells[cellKey(selectedStatus, auth.id)];
        if (cell?.phase !== "loaded") return null;
        return { authority: auth, detail: cell.detail };
      })
      .filter(Boolean) as Array<{
      authority: Authority;
      detail: AppDetail;
    }>;
  }, [selectedStatus, authorities, cells]);

  if (!meta) {
    return (
      <div style={{ padding: 40, fontFamily: "system-ui", color: "#64748b" }}>
        Loading…
      </div>
    );
  }

  return (
    <div style={{ fontFamily: "system-ui", minHeight: "100vh", background: "#f8fafc" }}>
      {/* Header */}
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
        <a
          href="/"
          style={{
            color: "#64748b",
            textDecoration: "none",
            fontSize: 14,
          }}
        >
          ← Back
        </a>
        <h1 style={{ margin: 0, fontSize: 18, fontWeight: 600, color: "#0f172a" }}>
          State Machine — QA
        </h1>
        <span style={{ color: "#94a3b8", fontSize: 13 }}>
          {authorities.length} councils × {ALL_STATUSES.length} statuses
        </span>
      </div>

      {/* Matrix */}
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
                  minWidth: 140,
                }}
              >
                Status
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
            {ALL_STATUSES.map((status) => {
              const style = STATUS_STYLE[status];
              const isSelected = selectedStatus === status;
              return (
                <tr
                  key={status}
                  onClick={() => selectStatus(status)}
                  style={{
                    cursor: "pointer",
                    background: isSelected ? `${style.color}08` : undefined,
                    borderLeft: isSelected ? `3px solid ${style.color}` : "3px solid transparent",
                  }}
                >
                  <td
                    style={{
                      padding: "10px 14px",
                      fontWeight: 500,
                      color: style.color,
                      borderBottom: "1px solid #f1f5f9",
                      position: "sticky",
                      left: 0,
                      background: isSelected ? `${style.color}08` : "#fff",
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
                        background: style.color,
                        color: "#fff",
                        fontSize: 11,
                        fontWeight: 700,
                      }}
                    >
                      {style.letter}
                    </span>
                    {style.label}
                  </td>
                  {authorities.map((a) => {
                    const key = cellKey(status, a.id);
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
                        {cell?.phase === "loading" && (
                          <span style={{ color: "#94a3b8" }}>…</span>
                        )}
                        {cell?.phase === "loaded" && (
                          <span
                            style={{
                              color: style.color,
                              fontWeight: 600,
                              fontSize: 16,
                            }}
                            title={cell.detail.planning_reference}
                          >
                            ●
                          </span>
                        )}
                        {cell?.phase === "empty" && (
                          <span style={{ color: "#e2e8f0" }} title="No example found">
                            —
                          </span>
                        )}
                        {(!cell || cell.phase === "idle") && (
                          <span style={{ color: "#e2e8f0" }}>·</span>
                        )}
                      </td>
                    );
                  })}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* Detail panels — side by side */}
      {selectedStatus && (
        <div style={{ padding: "0 24px 40px" }}>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              marginBottom: 16,
            }}
          >
            <span
              style={{
                display: "inline-flex",
                alignItems: "center",
                justifyContent: "center",
                width: 26,
                height: 26,
                borderRadius: "50%",
                background: STATUS_STYLE[selectedStatus]?.color ?? "#64748b",
                color: "#fff",
                fontSize: 12,
                fontWeight: 700,
              }}
            >
              {STATUS_STYLE[selectedStatus]?.letter}
            </span>
            <h2 style={{ margin: 0, fontSize: 16, fontWeight: 600, color: "#0f172a" }}>
              {STATUS_STYLE[selectedStatus]?.label ?? selectedStatus}
            </h2>
            <span style={{ color: "#94a3b8", fontSize: 13 }}>
              — {activePanels.length} example{activePanels.length !== 1 ? "s" : ""} found
              {authorities.some(
                (a) => cells[cellKey(selectedStatus, a.id)]?.phase === "loading"
              ) && ", loading more…"}
            </span>
          </div>

          {activePanels.length === 0 &&
            !authorities.some(
              (a) => cells[cellKey(selectedStatus, a.id)]?.phase === "loading"
            ) && (
              <div style={{ color: "#94a3b8", fontSize: 14, padding: "20px 0" }}>
                No examples found for this status across any council.
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
              {activePanels.map(({ authority, detail }) => (
                <div
                  key={authority.id}
                  style={{
                    border: "1px solid #e2e8f0",
                    borderRadius: 10,
                    overflow: "hidden",
                    background: "#fff",
                    maxHeight: "80vh",
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
                      <span style={{ color: "#94a3b8", fontWeight: 400 }}>
                        {detail.planning_reference}
                      </span>
                    </div>
                    {detail.status_raw && (
                      <div style={{ marginTop: 3, color: "#94a3b8", fontSize: 11 }}>
                        raw: <code style={{ background: "#f1f5f9", padding: "1px 4px", borderRadius: 3 }}>{detail.status_raw}</code>
                        {" → "}
                        <code style={{ background: "#f1f5f9", padding: "1px 4px", borderRadius: 3 }}>{detail.status}</code>
                        {" · "}
                        {authority.source_system}
                      </div>
                    )}
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
              ))}
            </Suspense>
          </div>
        </div>
      )}
    </div>
  );
}
