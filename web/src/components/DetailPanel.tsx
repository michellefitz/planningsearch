import {
  Fragment,
  useCallback,
  useEffect,
  useRef,
  useState,
  type TouchEvent as RTouchEvent,
} from "react";
import { api, type AppDetail, type DecisionConditions, type Meta, type ZoningInfo } from "../api";
import { SecondaryPills, StatusBadge } from "./ResultsList";
import { STATUS_STYLE } from "./MapView";

/**
 * Application detail (PRD F3) presented as a right-hand overlay sheet.
 *
 * The panel tells the story of an application in three tiers:
 *   1. Snapshot  — address, status, plain-English summary, key figures.
 *   2. The story — the decision (council + any appeal, with summaries and
 *                  conditions in one place) and the timeline.
 *   3. Dig deeper — the proposal as submitted, the facts, the documents,
 *                  and location context (zoning, flood, sales) as compact
 *                  data rows rather than full sections.
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
  // An Bord Pleanála appeal: lodged, then (once decided) the operative
  // outcome — it supersedes the council's decision above.
  if (d.appeal_lodged_date || d.appeal_reference || d.appeal_decision || d.appeal_status) {
    steps.push({
      label: d.appeal_reference ? `Appeal lodged — ${d.appeal_reference}` : "Appeal lodged",
      date: d.appeal_lodged_date,
      state: d.appeal_decision ? "done" : "current",
    });
    if (d.appeal_decision) {
      steps.push({
        label: `Appeal decided — ${d.appeal_decision}`,
        date: d.appeal_decision_date,
        state: "done",
      });
    } else if (d.appeal_status) {
      steps.push({ label: `Appeal — ${d.appeal_status}`, date: null, state: "current" });
    }
  }
  if (d.final_grant_date) {
    steps.push({ label: "Final grant issued", date: d.final_grant_date, state: "done" });
  }
  // BCMS: the builder's commencement notice (filed 14–28 days before starting)
  // and, where works finished, the completion certificate.
  if (d.commencement_date) {
    const future = d.commencement_date > new Date().toISOString().slice(0, 10);
    steps.push({
      label: future ? "Work due to commence" : "Work commenced on site",
      date: d.commencement_date,
      state: future ? "current" : "done",
    });
    if (d.completion_date) {
      steps.push({ label: "Completion certified", date: d.completion_date, state: "done" });
    }
  }
  return steps;
}

/**
 * Badge label for the header. When we couldn't map the register's status onto
 * a canonical one, show the council's own wording (title-cased) rather than a
 * bare "Unknown", so a status like "FINALISED UNCONDITIONAL" is still visible.
 */
function statusDisplayLabel(d: AppDetail): string {
  if (d.status === "unknown" && d.status_raw) {
    return d.status_raw.toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());
  }
  return d.status_label;
}

/**
 * The appeal reference, linked to the An Coimisiún Pleanála case file when we
 * could resolve one (appeal_url), otherwise plain text.
 */
function appealRef(d: AppDetail) {
  if (!d.appeal_reference) return null;
  if (!d.appeal_url) return <>{d.appeal_reference}</>;
  return (
    <a
      href={d.appeal_url}
      target="_blank"
      rel="noopener noreferrer"
      title="View the appeal case on An Coimisiún Pleanála"
    >
      {d.appeal_reference} ↗
    </a>
  );
}

/** Colour the outcome word so grants and refusals read at a glance. */
function outcomeClass(text: string): string {
  if (/refus/i.test(text)) return "outcome-refuse";
  if (/grant|conditional|approve/i.test(text)) return "outcome-grant";
  return "";
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
/** Street View metadata dates arrive as "YYYY-MM" (sometimes "YYYY"); show
 *  them as "Jun 2021" so users can judge how current the imagery is. */
function formatPanoDate(raw: string): string {
  const m = raw.match(/^(\d{4})(?:-(\d{2}))?/);
  if (!m) return raw;
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const month = m[2] ? months[Number(m[2]) - 1] : null;
  return month ? `${month} ${m[1]}` : m[1];
}

function PropertyMedia({ detail: d }: { detail: AppDetail }) {
  // null = no panorama / not loaded; object (with optional date) = coverage.
  const [pano, setPano] = useState<{ date: string | null } | null>(null);
  const hasCoords = d.lat != null && d.lng != null;

  useEffect(() => {
    setPano(null);
    if (!GMAPS_KEY || !hasCoords) return;
    const ctrl = new AbortController();
    fetch(
      `https://maps.googleapis.com/maps/api/streetview/metadata?location=${d.lat},${d.lng}&key=${GMAPS_KEY}`,
      { signal: ctrl.signal }
    )
      .then((r) => r.json())
      .then((m: { status: string; date?: string }) =>
        setPano(m.status === "OK" ? { date: m.date ?? null } : null)
      )
      .catch(() => setPano(null));
    return () => ctrl.abort();
  }, [d.id, d.lat, d.lng, hasCoords]);

  if (!GMAPS_KEY || !hasCoords) return null;
  const loc = `${d.lat},${d.lng}`;
  return (
    <div className="media-row">
      {pano && (
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
          <span className="media-label">
            Street View{pano.date ? ` · ${formatPanoDate(pano.date)}` : ""}
          </span>
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

/** Prescription codes on the council's decision, in display order. */
const CONDITION_GROUPS: Array<{ code: string; label: string }> = [
  { code: "R", label: "Reasons for refusal" },
  { code: "C", label: "Conditions of this decision" },
  { code: "D", label: "Further information the council asked for" },
  { code: "I", label: "Clarifications & informatives" },
  { code: "N", label: "Notes" },
];

// Councils with a structured conditions API — their decision substance comes
// from the conditions endpoint. Everywhere else (eplanning/iDocs councils)
// the reasons live only in the scanned decision order.
const AGILE_CONDITION_AUTHORITIES = new Set(["south-dublin", "dublin-city", "fingal", "dlr"]);

/** The full conditions / refusal reasons, grouped and collapsible. */
function ConditionGroups({ conditions }: { conditions: DecisionConditions }) {
  const groups = CONDITION_GROUPS.map((g) => ({
    ...g,
    items: conditions.items.filter((i) => i.code === g.code),
  })).filter((g) => g.items.length > 0);

  return (
    <>
      {groups.map((g) => (
        <div key={g.code} className="condition-group">
          <h4>
            {g.label} <span className="count">{g.items.length}</span>
          </h4>
          {g.items.map((item, i) => {
            const title = item.title || `${item.code_label} ${item.order}`;
            // Repeated titles (An Bord Pleanála conditions all arrive as
            // "ABP Condition") get their number appended to stay scannable.
            const dup = g.items.filter((x) => x.title === item.title).length > 1;
            return (
              <details key={`${g.code}-${item.order}-${i}`} className="condition">
                <summary>
                  <span className="condition-num">{item.order || i + 1}</span>
                  {dup && item.order ? `${title} ${item.order}` : title}
                </summary>
                {item.text && <p className="condition-text">{item.text}</p>}
              </details>
            );
          })}
        </div>
      ))}
    </>
  );
}

type SummaryState =
  | { phase: "idle" }
  | { phase: "loading" }
  | { phase: "loaded"; summary: string; source: string | null }
  | { phase: "empty" }
  | { phase: "failed" };

type DecisionOrderState =
  | { phase: "idle" }
  | { phase: "loading" }
  | { phase: "failed" }
  | { phase: "empty" }
  | {
      phase: "loaded";
      summary: string | null;
      conditions: Array<{ number: number | null; title: string; text: string }>;
      reasons: Array<{ number: number | null; text: string }>;
      source: string | null;
    };

/**
 * Read of the council's scanned decision order — for eplanning/iDocs councils
 * (e.g. Kildare) that expose no structured conditions, the summary, conditions
 * of grant and any reasons for refusal live only in that PDF.
 *
 * A refusal fetches automatically: its reasons are the point of the decision,
 * and every other council shows them inline, so a click here reads as clunky
 * and inconsistent. Grants keep the manual trigger — the conditions of grant
 * are supplementary and reading the PDF is slow enough to defer until asked.
 */
function DecisionOrderSummary({ detail: d }: { detail: AppDetail }) {
  const isRefusal = /refus/i.test(d.decision ?? "") || d.status === "refused";
  const [state, setState] = useState<DecisionOrderState>({ phase: "idle" });

  const load = useCallback(async () => {
    setState({ phase: "loading" });
    try {
      const res = await api.decisionSummary(d.id);
      const conditions = res.conditions ?? [];
      const reasons = res.reasons ?? [];
      if (res.summary || conditions.length || reasons.length)
        setState({
          phase: "loaded",
          summary: res.summary ?? null,
          conditions,
          reasons,
          source: res.source_document ?? null,
        });
      else setState({ phase: "empty" });
    } catch {
      setState({ phase: "failed" });
    }
  }, [d.id]);

  useEffect(() => {
    if (isRefusal) load();
    else setState({ phase: "idle" });
  }, [d.id, isRefusal, load]);

  return (
    <div className="on-demand">
      {state.phase === "idle" && (
        <button type="button" className="btn ai" onClick={load}>
          ✦ Read the decision order &amp; conditions
        </button>
      )}
      {state.phase === "loading" && (
        <span className="hint loading-line">Reading the decision order…</span>
      )}
      {state.phase === "failed" && (
        <>
          <p className="list-note">Couldn't read the decision order just now.</p>
          <button type="button" className="btn ai" onClick={load}>
            ✦ Try again
          </button>
        </>
      )}
      {state.phase === "empty" && (
        <p className="list-note">
          Couldn't find a readable decision order — see the documents below.
        </p>
      )}
      {state.phase === "loaded" && (
        <>
          {/* The AI summary is the readable version of the refusal — don't also
              dump the full reason wording underneath (it's long and hard to read
              in the panel). Fall back to the raw reasons only when there is no
              summary; the full order is a click away in the documents. */}
          {state.summary ? (
            <p className="ai-summary refusal-summary">✦ {state.summary}</p>
          ) : (
            state.reasons.length > 0 && (
              <div className="ai-summary refusal-summary">
                <ul className="decision-list">
                  {state.reasons.map((r, i) => (
                    <li key={i}>{r.text}</li>
                  ))}
                </ul>
              </div>
            )
          )}
          {state.conditions.length > 0 && (
            <div className="condition-group">
              <h4>
                Conditions of grant <span className="count">{state.conditions.length}</span>
              </h4>
              <ul className="decision-list">
                {state.conditions.map((c, i) => (
                  <li key={i}>
                    <strong>{c.title || `Condition ${c.number ?? i + 1}`}</strong>
                    {c.text && <span className="cond-text"> — {c.text}</span>}
                  </li>
                ))}
              </ul>
            </div>
          )}
          <p className="list-note">
            AI-extracted from "{state.source ?? "the decision order"}" — verify against the
            official decision order before relying on it.
          </p>
        </>
      )}
    </div>
  );
}

type AppealState =
  | { phase: "idle" }
  | { phase: "loading" }
  | {
      phase: "loaded";
      fields: Array<{ label: string; value: string }>;
      documents: Array<{ title: string; url: string }>;
    }
  | { phase: "empty" }
  | { phase: "failed" };

/**
 * The appeal, told inside the decision section: a one-click AI summary of the
 * case, the deep link to the file, and the fuller national record on demand.
 * Status/dates live in the timeline and facts, so they aren't repeated here.
 */
function AppealBlock({ detail: d }: { detail: AppDetail }) {
  const [state, setState] = useState<AppealState>({ phase: "idle" });
  const [summary, setSummary] = useState<SummaryState>({ phase: "idle" });
  useEffect(() => {
    setState({ phase: "idle" });
    setSummary({ phase: "idle" });
  }, [d.id]);
  if (!d.appeal_reference) return null;

  const load = async () => {
    setState({ phase: "loading" });
    try {
      const res = await api.appeal(d.id);
      if (res.fields?.length || res.documents?.length)
        setState({ phase: "loaded", fields: res.fields ?? [], documents: res.documents ?? [] });
      else setState({ phase: "empty" });
    } catch {
      setState({ phase: "failed" });
    }
  };

  const loadSummary = async () => {
    setSummary({ phase: "loading" });
    try {
      const res = await api.appealSummary(d.id);
      if (res.summary)
        setSummary({ phase: "loaded", summary: res.summary, source: res.based_on_document ?? null });
      else setSummary({ phase: "empty" });
    } catch {
      setSummary({ phase: "failed" });
    }
  };

  return (
    <div className="appeal-block">
      <h4>
        Appeal <span className="count">{appealRef(d)}</span>
      </h4>

      {summary.phase === "idle" && (
        <button type="button" className="btn ai" onClick={loadSummary}>
          ✦ Summarise the appeal
        </button>
      )}
      {summary.phase === "loading" && (
        <span className="hint loading-line">Reading the case file…</span>
      )}
      {summary.phase === "failed" && (
        <p className="list-note">Couldn't generate a summary just now — try again shortly.</p>
      )}
      {summary.phase === "empty" && (
        <p className="list-note">Not enough on the case file yet to summarise.</p>
      )}
      {summary.phase === "loaded" && (
        <blockquote className="ai-summary">
          {summary.summary}
          <footer className="hint">AI summary — verify against the case file.</footer>
        </blockquote>
      )}

      <div className="appeal-actions">
        {d.appeal_url && (
          <a className="btn portal" href={d.appeal_url} target="_blank" rel="noopener noreferrer">
            Case file on An Coimisiún Pleanála ↗
          </a>
        )}
        {state.phase === "idle" && (
          <button type="button" className="btn" onClick={load}>
            Load case details
          </button>
        )}
        {state.phase === "loading" && (
          <span className="hint loading-line">Fetching the national case record…</span>
        )}
      </div>
      {state.phase === "failed" && (
        <p className="list-note">
          Couldn't reach An Coimisiún Pleanála just now — use the case-file link above.
        </p>
      )}
      {state.phase === "empty" && (
        <p className="list-note">
          Nothing extra to show — the case file above has the full national record.
        </p>
      )}
      {state.phase === "loaded" && (
        <div className="appeal-details">
          {state.fields.length > 0 && (
            <dl className="facts">
              {state.fields.map((f) => (
                <Fragment key={f.label}>
                  <dt>{f.label}</dt>
                  <dd>{f.value}</dd>
                </Fragment>
              ))}
            </dl>
          )}
          {state.documents.length > 0 && (
            <>
              <p className="doc-list-label">Case documents</p>
              <ul className="doc-list">
                {state.documents.map((doc) => (
                  <li key={doc.url}>
                    <a href={doc.url} target="_blank" rel="noopener noreferrer">
                      {doc.title}
                    </a>
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * The story of the decision, in one place: the council's outcome (and the
 * appeal outcome where one supersedes it), the plain-English summaries, the
 * full conditions or refusal reasons, and the appeal.
 */
function DecisionSection({
  detail: d,
  conditions,
  conditionsLoading,
  refusalSummary,
  refusalLoading,
}: {
  detail: AppDetail;
  conditions: DecisionConditions | null;
  conditionsLoading: boolean;
  refusalSummary: string | null;
  refusalLoading: boolean;
}) {
  const decision = conditions?.decision ?? d.decision;
  const decisionDate = conditions?.decision_date ?? d.decision_date;
  const hasAppeal = Boolean(d.appeal_reference || d.appeal_decision);
  if (!decision && !hasAppeal) return null;
  // eplanning/iDocs councils record their reasons only in the scanned
  // decision order — offer the on-demand PDF summary instead of conditions.
  const scannedOrderOnly =
    Boolean(d.decision && d.scanned_files_url) && !AGILE_CONDITION_AUTHORITIES.has(d.authority_id);
  const summary = conditions?.refusal_summary ?? refusalSummary;

  return (
    <section aria-labelledby="decision-h" aria-busy={conditionsLoading || undefined}>
      <h3 id="decision-h">Decision</h3>
      {decision && (
        <p className="decision-headline">
          <span className={outcomeClass(decision)}>{decision}</span>
          {decisionDate && <span className="hint"> · {decisionDate}</span>}
          {/* A decided appeal supersedes the council decision — say so right
              where the council outcome is stated. */}
          {d.appeal_decision && (
            <>
              <span className="hint"> → on appeal: </span>
              <span className={outcomeClass(d.appeal_decision) || "appeal-outcome"}>
                {d.appeal_decision}
              </span>
              {d.appeal_decision_date && <span className="hint"> · {d.appeal_decision_date}</span>}
            </>
          )}
        </p>
      )}
      {d.commencement_date ? (
        <p className="commencement-line">
          {d.commencement_date > new Date().toISOString().slice(0, 10)
            ? "Work due to commence on site"
            : "Work has commenced on site"}
          <span className="hint"> · {d.commencement_date}</span>
          {d.commencement_notice && <span className="hint"> · notice {d.commencement_notice}</span>}
          {d.commencement_units != null && d.commencement_units > 0 && (
            <span className="hint"> · {d.commencement_units} units</span>
          )}
          {d.completion_date && (
            <span className="commencement-done"> · completion certified {d.completion_date}</span>
          )}
        </p>
      ) : (
        d.status === "granted" &&
        d.decision_date && (
          <p className="commencement-line commencement-none">
            No commencement notice on file — work does not appear to have started.
          </p>
        )
      )}
      {summary ? (
        <p className="ai-summary refusal-summary">✦ {summary}</p>
      ) : (
        refusalLoading && (
          <p className="ai-summary refusal-summary loading-line">✦ Summarising the reasons…</p>
        )
      )}
      {conditionsLoading && (
        <div className="skeleton-block" aria-hidden="true">
          <span />
          <span />
          <span />
        </div>
      )}
      {conditions && <ConditionGroups conditions={conditions} />}
      {scannedOrderOnly && <DecisionOrderSummary detail={d} />}
      <AppealBlock detail={d} />
    </section>
  );
}

type FilesState =
  | { phase: "idle" }
  | { phase: "loading" }
  | {
      phase: "loaded";
      files: Array<{ title: string; url: string }>;
      objections: number;
      direct: boolean;
    }
  | { phase: "failed" };

function ScannedFiles({ detail: d }: { detail: AppDetail }) {
  const [state, setState] = useState<FilesState>({ phase: "idle" });
  useEffect(() => setState({ phase: "idle" }), [d.id]);
  if (!d.scanned_files_url && !d.files_supported) return null;

  const load = async () => {
    setState({ phase: "loading" });
    try {
      const res = await api.files(d.id);
      if (res.files?.length)
        setState({
          phase: "loaded",
          files: res.files,
          objections: res.objection_count ?? 0,
          direct: Boolean(res.direct),
        });
      else setState({ phase: "failed" });
    } catch {
      setState({ phase: "failed" });
    }
  };

  return (
    <div className="scanned-files">
      {state.phase === "idle" && (
        <button type="button" className="btn" onClick={load}>
          Load the file list
        </button>
      )}
      {state.phase === "loading" && (
        <span className="hint loading-line">Fetching the file list from the council…</span>
      )}
      {state.phase === "failed" && (
        <p className="list-note">
          Couldn't load the file list from the council just now — try the official portal above.
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
              {/* direct=true (Agile): stable download URLs, link straight out.
                  Otherwise (Kildare iDocs): session-bound URLs, proxied
                  through our API so each click is self-contained. */}
              <a
                href={state.direct ? f.url : `/api/applications/${d.id}/files/${i}`}
                target="_blank"
                rel="noopener noreferrer"
              >
                {f.title}
              </a>
            </li>
          ))}
        </ul>
      )}
      {d.scanned_files_url && (
        <a
          className="link-btn viewer-link"
          href={d.scanned_files_url}
          target="_blank"
          rel="noopener noreferrer"
        >
          Open the council's file viewer ↗
        </a>
      )}
    </div>
  );
}

type Fetched<T> = T | "pending" | "none";

const NO_INFO = <span className="no-info">No information available</span>;
const CHECKING = <span className="hint loading-line">Checking…</span>;

/**
 * Location context — zoning, flood risk and recorded sales as one compact
 * list of data points, not full sections. Always the same three rows, so
 * every application reads the same way.
 */
function PropertyContext({
  detail: d,
  zones,
  flood,
  eircode,
}: {
  detail: AppDetail;
  zones: Fetched<ZoningInfo[]>;
  flood: Fetched<{ at_risk: boolean; scenarios: string[] }>;
  eircode: string | null;
}) {
  const sales = d.ppr_sales ?? [];

  return (
    <section aria-labelledby="place-h">
      <h3 id="place-h">Property information</h3>
      <dl className="place-list">
        <dt>Zoning</dt>
        <dd>
          {zones === "pending"
            ? CHECKING
            : zones === "none"
              ? NO_INFO
              : zones.map((z) => (
                  <div key={z.zone}>
                    <strong>{z.zone}</strong>
                    {z.general && ` · ${z.general}`}
                    {z.objective && ` — ${z.objective}`}
                    {z.plan_url && (
                      <>
                        {" "}
                        <a href={z.plan_url} target="_blank" rel="noopener noreferrer">
                          Development plan ↗
                        </a>
                      </>
                    )}
                  </div>
                ))}
        </dd>
        <dt>Flood risk</dt>
        <dd>
          {flood === "pending" ? (
            CHECKING
          ) : flood === "none" ? (
            NO_INFO
          ) : flood.at_risk ? (
            <span className="flood-warn-inline">
              Within a mapped flood extent
              {flood.scenarios.length > 0 && ` — ${flood.scenarios.join("; ")}`}
            </span>
          ) : (
            "None mapped at this location"
          )}
        </dd>
        <dt>Price register</dt>
        <dd>
          {sales.length === 0
            ? NO_INFO
            : sales.map((s) => (
                <div key={`${s.date}-${s.price}`}>
                  <strong>€{s.price.toLocaleString()}</strong>
                  <span className="hint"> · {s.date}</span>
                  {s.vat_exclusive && <span className="tag">price excludes VAT</span>}
                  {s.not_full_market && <span className="tag">not full market price</span>}
                </div>
              ))}
        </dd>
        <dt>Eircode</dt>
        <dd>{eircode ? <span className="ref">{eircode}</span> : NO_INFO}</dd>
      </dl>
    </section>
  );
}

/**
 * Kildare's own "Related Applications", fetched on demand from the eplanning
 * detail page. Ones already in our register open in place; the rest deep-link
 * to eplanning. Renders nothing while loading or when there are none.
 */
function EplanningRelated({
  detail: d,
  onSelectRelated,
}: {
  detail: AppDetail;
  onSelectRelated: (id: number) => void;
}) {
  const [items, setItems] = useState<
    Array<{
      id: number | null;
      planning_reference: string;
      description: string | null;
      address: string | null;
      received_date: string | null;
      status: string | null;
      eplanning_url: string;
    }> | null
  >(null);
  useEffect(() => {
    let alive = true;
    setItems(null);
    api
      .related(d.id)
      .then((r) => alive && setItems(r.related ?? []))
      .catch(() => alive && setItems([]));
    return () => {
      alive = false;
    };
  }, [d.id]);
  if (!items || items.length === 0) return null;
  return (
    <section aria-labelledby="related-h">
      <h3 id="related-h">Related applications</h3>
      <ul className="related-list">
        {items.map((r) => (
          <li key={r.id ?? r.eplanning_url} className="related-item">
            <div className="related-top">
              {r.id != null ? (
                <button
                  type="button"
                  className="link-btn ref"
                  onClick={() => onSelectRelated(r.id!)}
                >
                  {r.planning_reference}
                </button>
              ) : (
                <a className="ref" href={r.eplanning_url} target="_blank" rel="noopener noreferrer">
                  {r.planning_reference} ↗
                </a>
              )}
              {r.status && STATUS_STYLE[r.status] && (
                <StatusBadge status={r.status} label={STATUS_STYLE[r.status].label} />
              )}
              {r.received_date && <span className="related-date">received {r.received_date}</span>}
            </div>
            {r.description && <p className="related-desc">{r.description}</p>}
          </li>
        ))}
      </ul>
    </section>
  );
}

export default function DetailPanel({ detail: d, meta, onClose, onSelectRelated }: Props) {
  const glossary = meta?.glossary ?? {};
  const isEplanning =
    meta?.authorities.find((a) => a.id === d.authority_id)?.source_system === "eplanning";
  const timeline = buildTimeline(d);
  const [conditions, setConditions] = useState<DecisionConditions | null>(null);
  const [conditionsLoading, setConditionsLoading] = useState(false);
  const [refusalSummary, setRefusalSummary] = useState<string | null>(null);
  const [refusalLoading, setRefusalLoading] = useState(false);
  const [enrich, setEnrich] = useState<{
    ai_summary: string | null;
    applicant_name: string | null;
    agent_name: string | null;
    description?: string | null;
    eircode?: string | null;
    status?: string | null;
    status_raw?: string | null;
    status_label?: string | null;
  } | null>(null);
  const [enrichLoading, setEnrichLoading] = useState(false);
  const [descExpanded, setDescExpanded] = useState(false);
  const [zones, setZones] = useState<Fetched<ZoningInfo[]>>("pending");
  const [flood, setFlood] = useState<Fetched<{ at_risk: boolean; scenarios: string[] }>>("pending");
  // Enrichment can supply a fuller proposal description than the (sometimes
  // truncated) national one — prefer it for both the display and the summary.
  const description = enrich?.description ?? d.description ?? null;
  // The live portal status only overrides a baked "unknown" — the server sends
  // it exactly in that case, but guard here too so a correct baked status is
  // never displaced.
  const liveStatus = d.status === "unknown" ? enrich?.status ?? null : null;
  // ~65 chars per line at the sheet's width — beyond ~6 lines, clamp.
  const isLongDesc = (description ?? "").length > 400;
  const hasConditionsSource = AGILE_CONDITION_AUTHORITIES.has(d.authority_id);

  useEffect(() => {
    setConditions(null);
    setRefusalSummary(null);
    setRefusalLoading(false);
    setEnrich(null);
    setDescExpanded(false);
    let cancelled = false;
    if (d.lat != null && d.lng != null) {
      setZones("pending");
      setFlood("pending");
      api
        .zoning(d.id)
        .then((res) => {
          if (!cancelled) setZones(res.zones?.length ? res.zones : "none");
        })
        .catch(() => {
          if (!cancelled) setZones("none");
        });
      api
        .flood(d.id)
        .then((res) => {
          if (!cancelled) setFlood(res.flood ?? "none");
        })
        .catch(() => {
          if (!cancelled) setFlood("none");
        });
    } else {
      setZones("none");
      setFlood("none");
    }
    // AI summary + party backfill need upstream calls, so the detail
    // endpoint returns without them and they stream in here.
    let enrichDone: Promise<unknown> = Promise.resolve();
    if (!d.ai_summary || !d.applicant_name || !d.agent_name) {
      setEnrichLoading(true);
      enrichDone = api
        .enrich(d.id)
        .then((res) => {
          if (!cancelled) setEnrich(res);
        })
        .catch(() => {})
        .finally(() => {
          if (!cancelled) setEnrichLoading(false);
        });
    }
    // When the refusal came from the appeal (council granted, Commission
    // refused), the council's conditions hold no refusal reasons — they live
    // in the Board's order, so summarise the appeal into the same slot.
    if (
      d.appeal_decision &&
      /refus/i.test(d.appeal_decision) &&
      !/refus/i.test(d.decision ?? "")
    ) {
      setRefusalLoading(true);
      api
        .appealSummary(d.id)
        .then((r) => {
          if (!cancelled) setRefusalSummary(r.summary ?? null);
        })
        .catch(() => {})
        .finally(() => {
          if (!cancelled) setRefusalLoading(false);
        });
    }
    if (hasConditionsSource) {
      setConditionsLoading(true);
      // Conditions and enrich hit the same council portal, and conditions can
      // take 10s+ — hold it back until the summary has painted.
      enrichDone
        .then(() => {
          if (cancelled) return;
          return api.conditions(d.id).then((res) => {
            if (cancelled || !res.conditions?.items.length) return;
            setConditions(res.conditions);
            // The plain-English refusal line is generated on its own endpoint
            // so the conditions render immediately — fetch it once we know
            // there are refusal reasons to summarise.
            if (!res.conditions.refusal_summary && res.conditions.items.some((i) => i.code === "R")) {
              setRefusalLoading(true);
              api
                .refusalSummary(d.id)
                .then((r) => {
                  if (!cancelled) setRefusalSummary(r.summary ?? null);
                })
                .catch(() => {})
                .finally(() => {
                  if (!cancelled) setRefusalLoading(false);
                });
            }
          });
        })
        .catch(() => {})
        .finally(() => {
          if (!cancelled) setConditionsLoading(false);
        });
    }
    return () => {
      cancelled = true;
    };
  }, [d.id, d.ai_summary, d.applicant_name, d.agent_name, hasConditionsSource]);

  const aiSummary = d.ai_summary ?? enrich?.ai_summary ?? null;
  const applicant = d.applicant_name ?? enrich?.applicant_name ?? null;
  const agent = d.agent_name ?? enrich?.agent_name ?? null;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // Swipe-right-to-dismiss. The sheet is full-screen on mobile, so a rightward
  // swipe (iOS "back" gesture) reads more naturally than hunting for the ✕. We
  // drive the transform imperatively during the drag to keep it smooth and to
  // leave the CSS entry animation untouched.
  const sheetRef = useRef<HTMLElement>(null);
  const swipeStart = useRef<{ x: number; y: number } | null>(null);
  const swiping = useRef(false);

  const onTouchStart = (e: RTouchEvent) => {
    const t = e.touches[0];
    swipeStart.current = { x: t.clientX, y: t.clientY };
    swiping.current = false;
  };
  const onTouchMove = (e: RTouchEvent) => {
    const el = sheetRef.current;
    if (!swipeStart.current || !el) return;
    const t = e.touches[0];
    const dx = t.clientX - swipeStart.current.x;
    const dy = t.clientY - swipeStart.current.y;
    if (!swiping.current) {
      if (Math.abs(dx) < 10 && Math.abs(dy) < 10) return;
      // Only a mostly-horizontal rightward drag starts a swipe; otherwise it's
      // a normal vertical scroll, so bail out and leave it alone.
      if (dx <= 0 || Math.abs(dx) < Math.abs(dy)) {
        swipeStart.current = null;
        return;
      }
      swiping.current = true;
      el.style.transition = "none";
    }
    el.style.transform = `translateX(${Math.max(0, dx)}px)`;
  };
  const onTouchEnd = () => {
    const el = sheetRef.current;
    if (swiping.current && el) {
      const dx = parseFloat(el.style.transform.replace(/[^0-9.-]/g, "")) || 0;
      el.style.transition = "transform 220ms cubic-bezier(0.32, 0.72, 0, 1)";
      if (dx > Math.min(130, window.innerWidth * 0.3)) {
        el.style.transform = "translateX(100%)";
        window.setTimeout(onClose, 200);
      } else {
        el.style.transform = "";
      }
    }
    swipeStart.current = null;
    swiping.current = false;
  };

  return (
    <aside
      ref={sheetRef}
      className="detail-sheet"
      aria-label={`Application ${d.planning_reference}`}
      role="dialog"
      onTouchStart={onTouchStart}
      onTouchMove={onTouchMove}
      onTouchEnd={onTouchEnd}
    >
      <div className="sheet-top">
        <div className="sheet-status">
          {/* The national dataset lags the council portal, so a baked "unknown"
              status is corrected once enrichment reads the live portal status
              (e.g. an application since declared invalid). */}
          <StatusBadge
            status={liveStatus ?? d.status}
            label={liveStatus ? enrich?.status_label ?? liveStatus : statusDisplayLabel(d)}
          />
          {/* Retention is a materially different thing to an ordinary
              permission, so surface the type up here rather than only in the
              facts list. "Other" carries no signal, so it stays hidden. */}
          {d.application_type !== "other" && d.application_type_label && (
            <span className="pill pill-type" title="Application type">
              {d.application_type_label}
            </span>
          )}
          <SecondaryPills
            appealReference={d.appeal_reference}
            appealDecision={d.appeal_decision}
            appealUrl={d.appeal_url}
            commencementDate={d.commencement_date}
            completionDate={d.completion_date}
          />
        </div>
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
        {aiSummary ? (
          <p className="ai-summary lead-summary">✦ {aiSummary}</p>
        ) : enrichLoading ? (
          <p className="ai-summary lead-summary loading-line">✦ Writing a plain-English summary…</p>
        ) : (
          // Enrichment ran (enrich resolved) but produced no usable summary —
          // usually a description too thin/truncated to summarise. Say so
          // plainly rather than showing a stale or leaked model reply.
          enrich !== null &&
          description && (
            <p className="ai-summary lead-summary summary-empty">
              Not enough information to generate a summary.
            </p>
          )
        )}
        <PropertyMedia detail={d} />
        <div className="action-row">
          {(!GMAPS_KEY || d.lat == null) && <MapLinks detail={d} />}
          {d.portal_url && (
            <a
              className="btn btn-primary"
              // Agile portals need a click-time internal-id lookup for a
              // working deep link; the resolver 302s to the right page.
              href={d.portal_resolver ? `/api/applications/${d.id}/portal` : d.portal_url}
              target="_blank"
              rel="noopener noreferrer"
            >
              Official {d.authority_short_name} portal ↗
            </a>
          )}
        </div>
      </header>

      <DecisionSection
        detail={d}
        conditions={conditions}
        conditionsLoading={conditionsLoading}
        refusalSummary={refusalSummary}
        refusalLoading={refusalLoading}
      />

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

      <section aria-labelledby="desc-h">
        <h3 id="desc-h">Proposal as submitted</h3>
        <p className={`detail-desc ${isLongDesc && !descExpanded ? "clamped" : ""}`}>
          {withGlossary(description ?? "No description available.", glossary)}
        </p>
        {isLongDesc && (
          <button
            type="button"
            className="link-btn desc-toggle"
            aria-expanded={descExpanded}
            onClick={() => setDescExpanded((v) => !v)}
          >
            {descExpanded ? "Show less" : "Show all"}
          </button>
        )}
      </section>

      <section aria-labelledby="facts-h">
        <h3 id="facts-h">Details</h3>
        <dl className="facts">
          <dt>Type</dt>
          <dd>{withGlossary(d.application_type_label, glossary)}</dd>
          <dt>Applicant</dt>
          <dd>{applicant ?? "—"}</dd>
          <dt>Agent / architect</dt>
          <dd>{agent ?? "—"}</dd>
          <dt>Decision</dt>
          <dd>{d.decision ?? "Not yet decided"}</dd>
          {d.appeal_decision ? (
            <>
              <dt>Appeal decision</dt>
              <dd>
                {d.appeal_decision}
                {d.appeal_decision_date && (
                  <span className="hint"> — {d.appeal_decision_date}</span>
                )}
                {d.appeal_reference && <span className="hint"> ({appealRef(d)})</span>}
              </dd>
            </>
          ) : (
            d.appeal_reference && (
              <>
                <dt>Appeal</dt>
                <dd>
                  {d.appeal_status ?? "Lodged"}
                  <span className="hint"> ({appealRef(d)})</span>
                </dd>
              </>
            )
          )}
          {d.num_residential_units != null && d.num_residential_units > 0 && (
            <>
              <dt>Residential units</dt>
              <dd>{d.num_residential_units}</dd>
            </>
          )}
          {d.floor_area_sqm != null && d.floor_area_sqm > 0 && (
            <>
              <dt>Floor area</dt>
              <dd>{d.floor_area_sqm.toLocaleString()} m²</dd>
            </>
          )}
          {d.expiry_date && (
            <>
              <dt>Permission expires</dt>
              <dd>{d.expiry_date}</dd>
            </>
          )}
        </dl>
      </section>

      <section aria-labelledby="docs-h">
        <h3 id="docs-h">Documents</h3>
        {d.documents.length > 0 && (
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
        )}
        {d.documents.length === 0 && !d.scanned_files_url && !d.files_supported && (
          <p className="list-note">
            The drawings, forms, reports and decision orders are held on the council's own portal
            — use the portal link above.
          </p>
        )}
        <ScannedFiles detail={d} />
      </section>

      <PropertyContext
        detail={d}
        zones={zones}
        flood={flood}
        eircode={d.eircode ?? enrich?.eircode ?? null}
      />

      {isEplanning ? (
        // Kildare (eplanning): its own "Related Applications", since townland
        // addresses make same-address matching meaningless.
        <EplanningRelated detail={d} onSelectRelated={onSelectRelated} />
      ) : (
        d.related.length > 0 && (
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
        )
      )}

      <footer className="detail-footer">
        <p className="caveat">
          Data as of {d.last_synced?.slice(0, 10) ?? "unknown"}. This is a viewer over public
          register data — the {d.authority_name} register (and An Coimisiún Pleanála for appeals)
          is the authoritative source.
        </p>
      </footer>
    </aside>
  );
}
