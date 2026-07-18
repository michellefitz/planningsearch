import type { AppDetail, Meta } from "../api";
import { StatusBadge } from "./ResultsList";

/**
 * Single-page narrative application view (PRD F3): header, visual timeline,
 * facts panel, documents (deep-link floor, F4.7), related applications, and
 * the persistent official-portal link + freshness caveat (F3.8).
 */

interface Props {
  detail: AppDetail;
  meta: Meta | null;
  onClose: () => void;
  onSelectRelated: (id: number) => void;
}

interface TimelineStep {
  label: string;
  date: string | null;
  state: "done" | "current" | "future";
  statutory?: boolean;
}

function buildTimeline(d: AppDetail): TimelineStep[] {
  const decided = Boolean(d.decision_date);
  const steps: TimelineStep[] = [
    { label: "Received", date: d.received_date, state: d.received_date ? "done" : "future" },
    { label: "Validated", date: d.validated_date, state: d.validated_date ? "done" : "future" },
  ];
  if (d.further_info_requested_date) {
    steps.push({
      label: "Further information requested",
      date: d.further_info_requested_date,
      state: d.further_info_received_date || decided ? "done" : "current",
    });
    if (d.further_info_received_date) {
      steps.push({ label: "Further information received", date: d.further_info_received_date, state: "done" });
    }
  }
  steps.push({
    label: "Decision due",
    date: d.decision_due_date,
    state: decided ? "done" : "current",
    statutory: true,
  });
  steps.push({
    label: d.decision ? `Decided — ${d.decision}` : "Decision",
    date: d.decision_date,
    state: decided ? "done" : "future",
  });
  if (d.appeal_status) {
    steps.push({ label: `Appeal — ${d.appeal_status}`, date: null, state: "current" });
  }
  if (d.final_grant_date) {
    steps.push({ label: "Final grant issued", date: d.final_grant_date, state: "done" });
  }
  return steps;
}

/** Wrap glossary terms found in the text with a tooltip (PRD F3.3). */
function withGlossary(text: string, glossary: Record<string, string>): JSX.Element {
  const terms = Object.keys(glossary).sort((a, b) => b.length - a.length);
  const pattern = terms.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
  if (!pattern) return <>{text}</>;
  const re = new RegExp(`\\b(${pattern})\\b`, "gi");
  const parts = text.split(re);
  return (
    <>
      {parts.map((part, i) => {
        const def = glossary[part.toLowerCase()];
        return def ? (
          <abbr key={i} title={def} className="glossary-term">
            {part}
          </abbr>
        ) : (
          <span key={i}>{part}</span>
        );
      })}
    </>
  );
}

export default function DetailPanel({ detail: d, meta, onClose, onSelectRelated }: Props) {
  const glossary = meta?.glossary ?? {};
  const timeline = buildTimeline(d);
  return (
    <aside className="detail-panel" aria-label={`Application ${d.planning_reference}`}>
      <button type="button" className="btn detail-close" onClick={onClose} aria-label="Close application details">
        ✕ Close
      </button>

      <header className="detail-header">
        <StatusBadge status={d.status} label={d.status_label} />
        <h2>{d.address_text ?? d.planning_reference}</h2>
        <p className="detail-desc">{withGlossary(d.description ?? "No description available.", glossary)}</p>
        <p className="result-meta">
          {d.planning_reference} · {d.authority_name}
          {d.is_domestic_guess && (
            <span className="tag" title="Best-effort classification, not an official category">
              likely domestic
            </span>
          )}
        </p>
      </header>

      <section aria-labelledby="timeline-h">
        <h3 id="timeline-h">Timeline</h3>
        <ol className="timeline">
          {timeline.map((step, i) => (
            <li key={i} className={`tl-${step.state} ${step.statutory ? "tl-statutory" : ""}`}>
              <span className="tl-dot" aria-hidden="true" />
              <span className="tl-label">{withGlossary(step.label, glossary)}</span>
              <span className="tl-date">{step.date ?? "—"}</span>
            </li>
          ))}
        </ol>
        {!d.decision_date && d.decision_due_date && (
          <p className="caveat">
            Statutory dates shown are from the register as of the last sync. For anything
            time-critical (e.g. observation deadlines), confirm on the official portal.
          </p>
        )}
      </section>

      <section aria-labelledby="facts-h">
        <h3 id="facts-h">Details</h3>
        <dl className="facts">
          <dt>Reference</dt>
          <dd>{d.planning_reference}</dd>
          <dt>Authority</dt>
          <dd>{d.authority_name}</dd>
          <dt>Type</dt>
          <dd>{withGlossary(d.application_type_label, glossary)}</dd>
          <dt>Applicant</dt>
          <dd>{d.applicant_name ?? "—"}</dd>
          <dt>Agent</dt>
          <dd>{d.agent_name ?? "—"}</dd>
          <dt>Decision</dt>
          <dd>{d.decision ?? "Not yet decided"}</dd>
          {d.eircode && (
            <>
              <dt>Eircode</dt>
              <dd>{d.eircode}</dd>
            </>
          )}
        </dl>
      </section>

      <section aria-labelledby="docs-h">
        <h3 id="docs-h">Documents</h3>
        {d.documents.length > 0 ? (
          <ul className="doc-list">
            {d.documents.map((doc) =>
              doc.is_withheld ? (
                <li key={doc.id} className="doc-withheld">
                  {doc.title} — withheld by the council for data-protection reasons
                </li>
              ) : (
                <li key={doc.id}>
                  <a href={doc.source_url ?? d.portal_url ?? "#"} target="_blank" rel="noopener noreferrer">
                    {doc.title}
                  </a>{" "}
                  {doc.page_count != null && <span className="hint">({doc.page_count} pages)</span>}
                </li>
              )
            )}
          </ul>
        ) : (
          <p className="list-note">
            Scanned files (drawings, forms, reports, decision orders) are held on the council's own
            portal — they are not in the open dataset. Use the link below to view them.
          </p>
        )}
        {d.portal_url && (
          <a className="btn btn-primary portal-link" href={d.portal_url} target="_blank" rel="noopener noreferrer">
            View on official {d.authority_short_name} portal ↗
          </a>
        )}
      </section>

      {d.related.length > 0 && (
        <section aria-labelledby="related-h">
          <h3 id="related-h">Other applications at this address</h3>
          <ul className="related-list">
            {d.related.map((r) => (
              <li key={r.id}>
                <button type="button" className="link-btn" onClick={() => onSelectRelated(r.id)}>
                  {r.planning_reference}
                </button>{" "}
                — {r.description?.slice(0, 80)}…
              </li>
            ))}
          </ul>
        </section>
      )}

      <footer className="detail-footer">
        <p className="caveat">
          Data as of {d.last_synced?.slice(0, 10) ?? "unknown"}. This is a viewer over public
          register data — the {d.authority_name} register is the authoritative source.
        </p>
      </footer>
    </aside>
  );
}
