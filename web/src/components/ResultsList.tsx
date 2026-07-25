import type { CSSProperties, ReactNode } from "react";
import type { AppSummary } from "../api";
import type { SavedApp } from "../accountApi";
import { saveKey } from "../accountApi";
import { STATUS_STYLE } from "./MapView";
import SaveStar from "./SaveStar";

interface Props {
  results: AppSummary[];
  total: number;
  fuzzy: boolean;
  loading: boolean;
  selectedId: number | null;
  onSelect: (id: number) => void;
  onHover: (id: number | null) => void;
  savedByKey: Map<string, SavedApp>;
  onToggleSave: (authorityId: string, reference: string) => void;
}

export function StatusBadge({ status, label }: { status: string; label: string }) {
  const s = STATUS_STYLE[status] ?? STATUS_STYLE.unknown;
  return (
    <span className="status-badge" style={{ "--sc": s.color } as CSSProperties}>
      {label}
    </span>
  );
}

/**
 * Secondary pills for the axes the single status badge can't carry — appeal and
 * commencement (BCMS). They sit next to the status, so "granted" no longer
 * hides that a case went to appeal or that work has started on site. All data
 * is already on the record; nothing extra is fetched. `appealUrl` is only
 * passed where the pill isn't nested in a <button> (the detail sheet), since an
 * anchor inside a button is invalid markup — in the list it renders as text.
 */
export function SecondaryPills({
  appealReference,
  appealDecision,
  appealUrl,
  commencementDate,
  completionDate,
}: {
  appealReference?: string | null;
  appealDecision?: string | null;
  appealUrl?: string | null;
  commencementDate?: string | null;
  completionDate?: string | null;
}) {
  const pills: ReactNode[] = [];

  if (appealReference || appealDecision) {
    const label = appealDecision ? `Appeal: ${appealDecision}` : "Appealed";
    const title = "This application went to An Coimisiún Pleanála on appeal";
    pills.push(
      appealUrl ? (
        <a
          key="appeal"
          className="pill pill-appeal"
          href={appealUrl}
          target="_blank"
          rel="noopener noreferrer"
          title={title}
        >
          {label} ↗
        </a>
      ) : (
        <span key="appeal" className="pill pill-appeal" title={title}>
          {label}
        </span>
      )
    );
  }

  if (commencementDate) {
    const future = commencementDate > new Date().toISOString().slice(0, 10);
    const built = Boolean(completionDate);
    pills.push(
      <span
        key="commenced"
        className={`pill pill-commenced${built ? " pill-built" : ""}`}
        title={
          built
            ? "A completion certificate is on file with building control"
            : "A commencement notice was filed with building control for this permission"
        }
      >
        {built ? "Built" : future ? "Commencing" : "Commenced"}
      </span>
    );
  }

  if (!pills.length) return null;
  return <span className="pill-row">{pills}</span>;
}

export default function ResultsList({
  results,
  total,
  fuzzy,
  loading,
  selectedId,
  onSelect,
  onHover,
  savedByKey,
  onToggleSave,
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
                <SaveStar
                  saved={savedByKey.has(saveKey(r.authority_id, r.planning_reference))}
                  onToggle={() => onToggleSave(r.authority_id, r.planning_reference)}
                />
              </div>
              {/* Secondary axes the status badge can't carry — appeal and
                  commencement. No appealUrl here: the card is a <button>, so an
                  anchor pill would be invalid markup (it links from the sheet). */}
              <SecondaryPills
                appealReference={r.appeal_reference}
                commencementDate={r.commencement_date}
                completionDate={r.completion_date}
              />
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
              </p>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
