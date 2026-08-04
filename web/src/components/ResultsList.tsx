import type { CSSProperties, ReactNode } from "react";
import { fmtDate, type AppSummary } from "../api";
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
  /** How far back each register goes — shown when nothing matched. */
  coverage: string | null;
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
  numUnits,
}: {
  appealReference?: string | null;
  appealDecision?: string | null;
  appealUrl?: string | null;
  commencementDate?: string | null;
  completionDate?: string | null;
  numUnits?: number | null;
}) {
  const pills: ReactNode[] = [];

  // Only multi-unit schemes get a size pill — a "1 home" pill on every house
  // extension is noise, and the counts are best-effort below ~10 anyway.
  if (numUnits != null && numUnits >= 10) {
    pills.push(
      <span
        key="units"
        className="pill pill-units"
        title="Residential unit count from the register, or read from the application wording — treat as approximate"
      >
        {numUnits.toLocaleString()} homes
      </span>
    );
  }

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
        // Matched on the permission number the submitter typed onto the notice,
        // so it can attach the wrong site; on a phased scheme one completed
        // notice among several reads as "Built".
        title={
          built
            ? "A completion certificate is on file with building control, matched on the permission number cited on the notice"
            : "A commencement notice was filed with building control, matched on the permission number cited on the notice"
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
  coverage,
}: Props) {
  if (loading)
    return (
      <div className="skeleton-block results-skeleton" role="status" aria-label="Loading results">
        <span /><span /><span /><span /><span />
      </div>
    );
  if (results.length === 0)
    return (
      <div className="list-note">
        <p>No applications match. Try a broader term, or widen the map area / filters.</p>
        {/* A zero-result search reads as "nothing was ever applied for here"
            unless we say how far back we actually hold each register. */}
        {coverage && <p className="list-note-coverage">{coverage}</p>}
      </div>
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
              {/* The address is the row's identity, so it gets the full width;
                  status joins the pills beneath rather than squeezing it. */}
              <div className="result-top">
                <strong>{r.address_text ?? r.planning_reference}</strong>
                <SaveStar
                  saved={savedByKey.has(saveKey(r.authority_id, r.planning_reference))}
                  onToggle={() => onToggleSave(r.authority_id, r.planning_reference)}
                />
              </div>
              {/* Status plus the axes it can't carry — appeal and commencement.
                  No appealUrl here: the card is a <button>, so an anchor pill
                  would be invalid markup (it links from the sheet). */}
              <div className="result-pills">
                {/* A fuzzy hit is a *different* property that reads similarly —
                    it must never look like an exact one on a card someone may
                    screenshot or quote. */}
                {r.match_quality === "fuzzy" && (
                  <span
                    className="pill pill-fuzzy"
                    title="Not an exact match — your search returned no exact hits, so this is a close-looking result. Check the reference and address before relying on it."
                  >
                    Close match
                  </span>
                )}
                <StatusBadge status={r.status} label={r.status_label} />
                <SecondaryPills
                  appealReference={r.appeal_reference}
                  commencementDate={r.commencement_date}
                  completionDate={r.completion_date}
                  numUnits={r.num_residential_units}
                />
              </div>
              <p className="result-desc">{r.description}</p>
              <p className="result-meta">
                <span className="ref">{r.planning_reference}</span> · {r.authority_short_name}
                {r.received_date && ` · received ${fmtDate(r.received_date)}`}
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
