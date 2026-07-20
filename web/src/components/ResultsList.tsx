import type { CSSProperties } from "react";
import type { AppSummary } from "../api";
import { STATUS_STYLE } from "./MapView";

interface Props {
  results: AppSummary[];
  total: number;
  fuzzy: boolean;
  loading: boolean;
  selectedId: number | null;
  onSelect: (id: number) => void;
  onHover: (id: number | null) => void;
}

export function StatusBadge({ status, label }: { status: string; label: string }) {
  const s = STATUS_STYLE[status] ?? STATUS_STYLE.unknown;
  return (
    <span className="status-badge" style={{ "--sc": s.color } as CSSProperties}>
      {label}
    </span>
  );
}

export default function ResultsList({
  results,
  total,
  fuzzy,
  loading,
  selectedId,
  onSelect,
  onHover,
}: Props) {
  if (loading) return <p className="list-note" role="status">Searching…</p>;
  if (results.length === 0)
    return (
      <p className="list-note">
        No applications match. Try a broader term, or widen the map area / filters.
      </p>
    );
  return (
    <div className="results">
      <p className="list-note" role="status">
        {total.toLocaleString()} application{total === 1 ? "" : "s"}
        {fuzzy && " — showing close matches (no exact hits)"}
      </p>
      <ul className="result-list">
        {results.map((r) => (
          <li key={r.id}>
            <button
              type="button"
              className={`result-card ${selectedId === r.id ? "result-selected" : ""}`}
              onClick={() => onSelect(r.id)}
              onMouseEnter={() => onHover(r.id)}
              onMouseLeave={() => onHover(null)}
              onFocus={() => onHover(r.id)}
              onBlur={() => onHover(null)}
            >
              <div className="result-top">
                <strong>{r.address_text ?? r.planning_reference}</strong>
                <StatusBadge status={r.status} label={r.status_label} />
              </div>
              <p className="result-desc">{r.description}</p>
              <p className="result-meta">
                <span className="ref">{r.planning_reference}</span> · {r.authority_short_name}
                {r.received_date && ` · received ${r.received_date}`}
                {r.distance_km != null && ` · ${r.distance_km} km away`}
                {r.is_domestic_guess && (
                  <span className="tag" title="Best-effort classification, not an official category">
                    likely domestic
                  </span>
                )}
                {r.commencement_date && (
                  <span
                    className="tag tag-commenced"
                    title="A commencement notice was filed with building control for this permission"
                  >
                    {r.completion_date ? "built" : "work commenced"}
                  </span>
                )}
              </p>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
