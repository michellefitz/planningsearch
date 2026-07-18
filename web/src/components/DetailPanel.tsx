import { useEffect, useState } from "react";
import { api, type AppDetail, type Meta } from "../api";
import { StatusBadge } from "./ResultsList";

/**
 * Application detail (PRD F3) presented as a right-hand overlay sheet:
 * header with AI summary and property links, key-figure tiles, visual
 * timeline, facts grid, documents (deep-link floor, F4.7), related
 * applications, and the persistent official-portal link + freshness
 * caveat (F3.8).
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

/** Open the property in Google Maps — Street View and satellite when we have
 *  coordinates, otherwise an address search (official Maps URLs API, no key). */
function MapLinks({ detail: d }: { detail: AppDetail }) {
  const hasCoords = d.lat != null && d.lng != null;
  if (!hasCoords && !d.address_text) return null;
  return (
    <>
      {hasCoords ? (
        <>
          <a
            className="btn"
            href={`https://www.google.com/maps/@?api=1&map_action=pano&viewpoint=${d.lat},${d.lng}`}
            target="_blank"
            rel="noopener noreferrer"
          >
            Street View ↗
          </a>
          {/* q drops a pin; t=k is the satellite basemap — the documented
              URLs API can't do both at once. */}
          <a
            className="btn"
            href={`https://maps.google.com/?q=${d.lat},${d.lng}&t=k&z=19`}
            target="_blank"
            rel="noopener noreferrer"
          >
            Aerial view ↗
          </a>
        </>
      ) : (
        <a
          className="btn"
          href={`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(d.address_text!)}`}
          target="_blank"
          rel="noopener noreferrer"
        >
          Find on Google Maps ↗
        </a>
      )}
    </>
  );
}

const GMAPS_KEY = import.meta.env.VITE_GOOGLE_MAPS_KEY as string | undefined;

/**
 * Inline Street View + satellite thumbnails via Google's static image APIs
 * (needs VITE_GOOGLE_MAPS_KEY; renders nothing without it). The free
 * metadata endpoint gates the Street View pane so places with no coverage
 * don't show Google's grey placeholder.
 */
function PropertyMedia({ detail: d }: { detail: AppDetail }) {
  const [hasPano, setHasPano] = useState<boolean | null>(null);
  const hasCoords = d.lat != null && d.lng != null;

  useEffect(() => {
    setHasPano(null);
    if (!GMAPS_KEY || !hasCoords) return;
    const ctrl = new AbortController();
    fetch(
      `https://maps.googleapis.com/maps/api/streetview/metadata?location=${d.lat},${d.lng}&key=${GMAPS_KEY}`,
      { signal: ctrl.signal }
    )
      .then((r) => r.json())
      .then((m: { status: string }) => setHasPano(m.status === "OK"))
      .catch(() => setHasPano(false));
    return () => ctrl.abort();
  }, [d.id, d.lat, d.lng, hasCoords]);

  if (!GMAPS_KEY || !hasCoords) return null;
  const loc = `${d.lat},${d.lng}`;
  return (
    <div className="media-row">
      {hasPano && (
        <a
          href={`https://www.google.com/maps/@?api=1&map_action=pano&viewpoint=${loc}`}
          target="_blank"
          rel="noopener noreferrer"
          className="media-tile"
        >
          <img
            src={`https://maps.googleapis.com/maps/api/streetview?size=640x360&location=${loc}&key=${GMAPS_KEY}`}
            alt={`Street View of ${d.address_text ?? "the property"}`}
            loading="lazy"
          />
          <span className="media-label">Street View</span>
        </a>
      )}
      <a
        href={`https://maps.google.com/?q=${loc}&t=k&z=19`}
        target="_blank"
        rel="noopener noreferrer"
        className="media-tile"
      >
        <img
          src={`https://maps.googleapis.com/maps/api/staticmap?center=${loc}&zoom=18&maptype=satellite&size=640x360&markers=color:red%7C${loc}&key=${GMAPS_KEY}`}
          alt={`Aerial view of ${d.address_text ?? "the property"}`}
          loading="lazy"
        />
        <span className="media-label">Aerial</span>
      </a>
    </div>
  );
}

const DAY_MS = 86_400_000;

/** Key figures worth surfacing as tiles; only render what the record has. */
function buildStats(d: AppDetail): Array<{ label: string; value: string }> {
  const stats: Array<{ label: string; value: string }> = [];
  if (d.num_residential_units) {
    stats.push({
      label: "Residential units",
      value: String(d.num_residential_units),
    });
  }
  if (d.floor_area_sqm) {
    stats.push({ label: "Floor area", value: `${d.floor_area_sqm.toLocaleString()} m²` });
  }
  if (d.decision_date && d.received_date) {
    const days = Math.round((Date.parse(d.decision_date) - Date.parse(d.received_date)) / DAY_MS);
    if (days > 0) stats.push({ label: "Decided in", value: `${days} days` });
  } else if (d.decision_due_date) {
    const days = Math.ceil((Date.parse(d.decision_due_date) - Date.now()) / DAY_MS);
    if (days >= 0) stats.push({ label: "Decision due in", value: `${days} day${days === 1 ? "" : "s"}` });
  }
  if (d.expiry_date) {
    stats.push({ label: "Permission expires", value: d.expiry_date });
  }
  return stats;
}

type FilesState =
  | { phase: "idle" }
  | { phase: "loading" }
  | { phase: "loaded"; files: Array<{ title: string; url: string }>; objections: number }
  | { phase: "failed" };

function ScannedFiles({ detail: d }: { detail: AppDetail }) {
  const [state, setState] = useState<FilesState>({ phase: "idle" });
  useEffect(() => setState({ phase: "idle" }), [d.id]);
  if (!d.scanned_files_url) return null;

  const load = async () => {
    setState({ phase: "loading" });
    try {
      const res = await api.files(d.id);
      if (res.files?.length)
        setState({ phase: "loaded", files: res.files, objections: res.objection_count ?? 0 });
      else setState({ phase: "failed" });
    } catch {
      setState({ phase: "failed" });
    }
  };

  return (
    <div className="scanned-files">
      <a className="btn portal" href={d.scanned_files_url} target="_blank" rel="noopener noreferrer">
        View scanned files on council viewer ↗
      </a>{" "}
      {state.phase === "idle" && (
        <button type="button" className="btn" onClick={load}>
          List files here
        </button>
      )}
      {state.phase === "loading" && <span className="hint">Fetching file list from the council…</span>}
      {state.phase === "failed" && (
        <p className="list-note">
          Couldn't read the council's file list just now — use the scanned-files link above.
        </p>
      )}
      {state.phase === "loaded" && state.objections > 0 && (
        <p className="objection-flag">
          {state.objections} third-party submission{state.objections === 1 ? "" : "s"} /
          objection{state.objections === 1 ? "" : "s"} on file
        </p>
      )}
      {state.phase === "loaded" && (
        <ul className="doc-list">
          {state.files.map((f, i) => (
            <li key={f.url}>
              {/* Proxied through our API: the council's raw file URLs are
                  session-bound and serve the wrong document outside the
                  session that produced them. */}
              <a
                href={`/api/applications/${d.id}/files/${i}`}
                target="_blank"
                rel="noopener noreferrer"
              >
                {f.title}
              </a>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export default function DetailPanel({ detail: d, meta, onClose, onSelectRelated }: Props) {
  const glossary = meta?.glossary ?? {};
  const timeline = buildTimeline(d);
  const stats = buildStats(d);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <aside className="detail-sheet" aria-label={`Application ${d.planning_reference}`} role="dialog">
      <div className="sheet-top">
        <StatusBadge status={d.status} label={d.status_label} />
        <button type="button" className="sheet-close" onClick={onClose} aria-label="Close application details">
          ✕
        </button>
      </div>

      <header className="detail-header">
        <h2>{d.address_text ?? d.planning_reference}</h2>
        <p className="result-meta">
          <span className="ref">{d.planning_reference}</span> · {d.authority_name}
          {d.received_date && ` · received ${d.received_date}`}
          {d.is_domestic_guess && (
            <span className="tag" title="Best-effort classification, not an official category">
              likely domestic
            </span>
          )}
        </p>
        {d.ai_summary && <p className="detail-summary">✦ {d.ai_summary}</p>}
        <PropertyMedia detail={d} />
        <div className="action-row">
          {(!GMAPS_KEY || d.lat == null) && <MapLinks detail={d} />}
          {d.portal_url && (
            <a className="btn btn-primary" href={d.portal_url} target="_blank" rel="noopener noreferrer">
              Official {d.authority_short_name} portal ↗
            </a>
          )}
        </div>
      </header>

      {stats.length > 0 && (
        <div className="stat-row">
          {stats.map((s) => (
            <div key={s.label} className="stat">
              <span className="stat-value">{s.value}</span>
              <span className="stat-label">{s.label}</span>
            </div>
          ))}
        </div>
      )}

      <section aria-labelledby="desc-h">
        <h3 id="desc-h">Planning description</h3>
        <p className="detail-desc">{withGlossary(d.description ?? "No description available.", glossary)}</p>
      </section>

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
          <dd className="ref">{d.planning_reference}</dd>
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
            portal — they are not in the open dataset.
          </p>
        )}
        <ScannedFiles detail={d} />
      </section>

      {d.ppr_sales && d.ppr_sales.length > 0 && (
        <section aria-labelledby="ppr-h">
          <h3 id="ppr-h">Property price register</h3>
          <ul className="sale-list">
            {d.ppr_sales.map((s) => (
              <li key={`${s.date}-${s.price}`} className="sale-row">
                <span className="sale-price">€{s.price.toLocaleString()}</span>
                <span className="sale-info">
                  <span className="sale-date">{s.date}</span>
                  {s.description && <span className="sale-desc">{s.description}</span>}
                  {s.vat_exclusive && <span className="tag">price excludes VAT</span>}
                  {s.not_full_market && <span className="tag">not full market price</span>}
                </span>
              </li>
            ))}
          </ul>
          <p className="list-note">
            Matched to this address on the PSRA register — confirm there before relying on it.{" "}
            <a href="https://www.propertypriceregister.ie/" target="_blank" rel="noopener noreferrer">
              Search the Property Price Register ↗
            </a>
          </p>
        </section>
      )}

      {d.related.length > 0 && (
        <section aria-labelledby="related-h">
          <h3 id="related-h">Other applications at this address</h3>
          <ul className="related-list">
            {d.related.map((r) => (
              <li key={r.id}>
                <button type="button" className="link-btn ref" onClick={() => onSelectRelated(r.id)}>
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
