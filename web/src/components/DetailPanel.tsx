import { Fragment, useCallback, useEffect, useRef, useState } from "react";
import { api, fmtDate, type AppDetail, type DecisionConditions, type Meta, type ZoningInfo } from "../api";
import PropertyMedia, { GMAPS_KEY, MapLinks } from "./PropertyMedia";
import { XIcon } from "./icons";
import { SecondaryPills, StatusBadge } from "./ResultsList";
import { STATUS_STYLE } from "./MapView";
import SaveStar from "./SaveStar";
import { getFloodData } from "../floodData";
import { coverageNoteFor } from "../coverage";
import booleanPointInPolygon from "@turf/boolean-point-in-polygon";
import { point as turfPoint } from "@turf/helpers";

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
  saved: boolean;
  onToggleSave: () => void;
  closing?: boolean;
}

interface TimelineStep {
  label: string;
  date: string | null;
  state: "done" | "current" | "future";
  statutory?: boolean;
}

/** Whole days from today until an ISO date; negative once it has passed. */
function daysUntil(iso: string): number {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const then = new Date(`${iso}T00:00:00`);
  return Math.round((then.getTime() - today.getTime()) / 86_400_000);
}

const isPast = (iso: string): boolean => daysUntil(iso) < 0;

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
  // The window for public submissions/observations closes before the decision.
  if (d.submissions_by_date) {
    steps.push({
      label: "Submissions by",
      date: d.submissions_by_date,
      state: decided || isPast(d.submissions_by_date) ? "done" : "current",
      statutory: true,
    });
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

function titleCase(s: string): string {
  return s.toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());
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
          ✦ Summarise the decision
        </button>
      )}
      {state.phase === "loading" && (
        <span className="hint loading-line">Summarising the decision…</span>
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
          {/* Red is reserved for refusals — a granted order's summary sits in
              the standard blue AI-summary box like every other summary. */}
          {state.summary ? (
            <p className={`ai-summary${isRefusal ? " refusal-summary" : ""}`}>✦ {state.summary}</p>
          ) : (
            state.reasons.length > 0 && (
              <div className={`ai-summary${isRefusal ? " refusal-summary" : ""}`}>
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
        <span className="hint loading-line">Summarising the appeal…</span>
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

      {state.phase === "idle" && (
        <>
          <div className="doc-skeleton" aria-hidden="true">
            <span /><span /><span />
          </div>
          <button type="button" className="btn" onClick={load}>
            Load case details
          </button>
        </>
      )}
      {state.phase === "loading" && (
        <span className="hint loading-line">Fetching the national case record…</span>
      )}
      {d.appeal_url && (
        <a className="link-btn viewer-link" href={d.appeal_url} target="_blank" rel="noopener noreferrer">
          Case file on An Coimisiún Pleanála ↗
        </a>
      )}
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
/**
 * Copy (or, on mobile, share) the application's own address. The panel is a
 * real URL now, so a link into a WhatsApp group or an email lands someone
 * straight on the property rather than on the map.
 */
function ShareLink({ detail: d }: { detail: AppDetail }) {
  const [copied, setCopied] = useState(false);
  const share = async () => {
    const url = window.location.href;
    const title = d.address_text ?? d.planning_reference;
    // Native share sheet where there is one; clipboard everywhere else.
    if (navigator.share) {
      try {
        await navigator.share({ title, text: `${title} — planning application`, url });
        return;
      } catch {
        // cancelled or unsupported — fall through to copying
      }
    }
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
    } catch {
      // clipboard blocked — the address bar already shows the link
    }
  };
  return (
    <button
      type="button"
      className="sheet-share"
      onClick={share}
      aria-label="Copy a link to this application"
      title="Copy a link to this application"
    >
      {copied ? "Link copied" : (
        <>
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M4 12v7a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-7" />
            <polyline points="16 6 12 2 8 6" />
            <line x1="12" y1="2" x2="12" y2="15" />
          </svg>
          {" "}Share
        </>
      )}
    </button>
  );
}

function DecisionSection({
  detail: d,
  conditions,
  conditionsLoading,
  conditionsFailed,
  refusalSummary,
  refusalLoading,
}: {
  detail: AppDetail;
  conditions: DecisionConditions | null;
  conditionsLoading: boolean;
  conditionsFailed: boolean;
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
          <span className={outcomeClass(decision)}>{titleCase(decision)}</span>
          {decisionDate && <span className="hint"> · {fmtDate(decisionDate)}</span>}
          {d.appeal_decision && (
            <>
              <span className="hint"> → on appeal: </span>
              <span className={outcomeClass(d.appeal_decision) || "appeal-outcome"}>
                {titleCase(d.appeal_decision)}
              </span>
              {d.appeal_decision_date && <span className="hint"> · {fmtDate(d.appeal_decision_date)}</span>}
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
      ) : null}
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
      {conditions && conditions.items.length > 0 && <ConditionGroups conditions={conditions} />}
      {/* Three distinct outcomes, never collapsed into a blank space: the
          council recorded none, or we couldn't reach the council at all. */}
      {!conditionsLoading && conditions && conditions.items.length === 0 && (
        <p className="section-note">
          The council's register records no conditions or reasons for this decision.
        </p>
      )}
      {!conditionsLoading && conditionsFailed && (
        <p className="section-note section-note-warn">
          Couldn't load the conditions from {d.authority_name} just now — this does{" "}
          <strong>not</strong> mean there are none. Check the council's portal using the link
          above.
        </p>
      )}
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
        <>
          <div className="doc-skeleton" aria-hidden="true">
            <span /><span /><span /><span />
          </div>
          <button type="button" className="btn" onClick={load}>
            Load the file list
          </button>
        </>
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
        <dt>Flood zone</dt>
        <dd>
          {flood === "pending" ? (
            CHECKING
          ) : flood === "none" ? (
            NO_INFO
          ) : flood.at_risk ? (
            <span className="flood-warn-inline">
              Within a mapped flood zone
              {flood.scenarios.length > 0 && ` — ${flood.scenarios.join("; ")}`}
            </span>
          ) : (
            "Not within a mapped flood zone"
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
              {r.received_date && <span className="related-date">received {fmtDate(r.received_date)}</span>}
            </div>
            {r.description && <p className="related-desc">{r.description}</p>}
          </li>
        ))}
      </ul>
    </section>
  );
}

function useIsMobile(): boolean {
  const [m, setM] = useState(
    () => typeof window !== "undefined" && window.matchMedia("(max-width: 767px)").matches
  );
  useEffect(() => {
    const mq = window.matchMedia("(max-width: 767px)");
    const on = () => setM(mq.matches);
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);
  return m;
}

export default function DetailPanel({ detail: d, meta, onClose, onSelectRelated, saved, onToggleSave, closing }: Props) {
  const glossary = meta?.glossary ?? {};
  const isMobile = useIsMobile();
  const isEplanning =
    meta?.authorities.find((a) => a.id === d.authority_id)?.source_system === "eplanning";
  const timeline = buildTimeline(d);
  const [conditions, setConditions] = useState<DecisionConditions | null>(null);
  const [conditionsLoading, setConditionsLoading] = useState(false);
  // A council portal that didn't answer must never look like a permission with
  // no conditions attached — those are opposite facts. Track the outcome of the
  // fetch, not just whether we ended up with rows.
  const [conditionsFailed, setConditionsFailed] = useState(false);
  const [refusalSummary, setRefusalSummary] = useState<string | null>(null);
  const [refusalLoading, setRefusalLoading] = useState(false);
  const [enrich, setEnrich] = useState<{
    ai_summary: string | null;
    applicant_name: string | null;
    agent_name: string | null;
    description?: string | null;
    eircode?: string | null;
    officer_name?: string | null;
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
    setConditionsFailed(false);
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
      getFloodData()
        .then((fc) => {
          if (cancelled) return;
          if (!fc || d.lat == null || d.lng == null) {
            setFlood("none");
            return;
          }
          const pt = turfPoint([d.lng, d.lat]);
          const hits = fc.features.filter(
            (f) =>
              (f.geometry.type === "Polygon" || f.geometry.type === "MultiPolygon") &&
              booleanPointInPolygon(pt, f as GeoJSON.Feature<GeoJSON.Polygon | GeoJSON.MultiPolygon>)
          );
          if (hits.length === 0) {
            setFlood({ at_risk: false, scenarios: [] });
            return;
          }
          const scenarios = [
            ...new Set(
              hits
                .map((f) => String((f.properties as Record<string, unknown>)?.scenario ?? "").trim())
                .filter(Boolean)
            ),
          ];
          setFlood({ at_risk: true, scenarios });
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
      setConditionsFailed(false);
      // Conditions and enrich hit the same council portal, and conditions can
      // take 10s+ — hold it back until the summary has painted.
      enrichDone
        .then(() => {
          if (cancelled) return;
          return api.conditions(d.id).then((res) => {
            if (cancelled) return;
            // Store the result even when empty: "the council recorded none" is
            // a real answer and must render differently from a failed lookup.
            setConditions(res.conditions ?? null);
            if (!res.conditions) setConditionsFailed(true);
            if (!res.conditions?.items.length) return;
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
        .catch(() => {
          if (!cancelled) setConditionsFailed(true);
        })
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

  // On mobile the sheet is a bottom sheet that peeks over the map: it opens to a
  // peek height and drags up (expand) / down (dismiss), snapping to peek / full
  // / closed. Desktop is unchanged (a side panel).
  const sheetRef = useRef<HTMLElement>(null);
  const [expanded, setExpanded] = useState(false);
  const expandedRef = useRef(expanded);
  expandedRef.current = expanded;
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const peekOffset = () => Math.round(window.innerHeight * 0.44);

  // Entry + snap: animate to the peek/full position when it opens or `expanded`
  // changes (drags set the transform imperatively in the listener below).
  useEffect(() => {
    const el = sheetRef.current;
    if (!el || !isMobile) return;
    el.style.transition = "transform 300ms cubic-bezier(0.32, 0.72, 0, 1)";
    el.style.transform = `translateY(${expanded ? 0 : peekOffset()}px)`;
  }, [isMobile, expanded]);

  // Drag gesture. Native listeners (not React's passive ones) so we can
  // preventDefault and stop the content from scrolling while dragging the sheet.
  // Arbitration: at peek every drag moves the sheet; at full it moves only on a
  // downward drag from the top (otherwise the content scrolls normally).
  useEffect(() => {
    const el = sheetRef.current;
    if (!el || !isMobile) return;
    let startY = 0;
    let base = 0;
    let lastY = 0;
    let lastT = 0;
    let vy = 0;
    let mode: null | "drag" | "scroll" = null;

    const start = (e: TouchEvent) => {
      startY = lastY = e.touches[0].clientY;
      lastT = e.timeStamp;
      vy = 0;
      base = expandedRef.current ? 0 : peekOffset();
      mode = null;
      el.style.transition = "none";
    };
    const move = (e: TouchEvent) => {
      const y0 = e.touches[0].clientY;
      const dy = y0 - startY;
      if (mode === null) {
        if (Math.abs(dy) < 6) return;
        mode = !expandedRef.current || (dy > 0 && el.scrollTop <= 0) ? "drag" : "scroll";
      }
      if (mode !== "drag") return;
      e.preventDefault();
      const dt = e.timeStamp - lastT;
      if (dt > 0) vy = (y0 - lastY) / dt;
      lastY = y0;
      lastT = e.timeStamp;
      el.style.transform = `translateY(${Math.max(0, base + dy)}px)`;
    };
    const end = () => {
      if (mode !== "drag") {
        mode = null;
        return;
      }
      mode = null;
      const y = parseFloat(el.style.transform.replace(/[^0-9.-]/g, "")) || 0;
      const peek = peekOffset();
      const innerH = window.innerHeight;
      let target: "full" | "peek" | "dismiss";
      if (vy > 0.5) target = expandedRef.current ? "peek" : "dismiss";
      else if (vy < -0.5) target = "full";
      else if (y > peek + innerH * 0.12) target = "dismiss";
      else if (y < peek * 0.5) target = "full";
      else target = "peek";

      el.style.transition = "transform 260ms cubic-bezier(0.32, 0.72, 0, 1)";
      if (target === "dismiss") {
        el.style.transform = "translateY(100%)";
        window.setTimeout(() => onCloseRef.current(), 240);
      } else if (target === "full") {
        el.style.transform = "translateY(0px)";
        setExpanded(true);
      } else {
        el.style.transform = `translateY(${peek}px)`;
        setExpanded(false);
      }
    };

    el.addEventListener("touchstart", start, { passive: true });
    el.addEventListener("touchmove", move, { passive: false });
    el.addEventListener("touchend", end);
    el.addEventListener("touchcancel", end);
    return () => {
      el.removeEventListener("touchstart", start);
      el.removeEventListener("touchmove", move);
      el.removeEventListener("touchend", end);
      el.removeEventListener("touchcancel", end);
    };
  }, [isMobile]);

  return (
    <aside
      ref={sheetRef}
      className={`detail-sheet ${isMobile ? "sheet-mobile" : ""}${closing ? " sheet-closing" : ""}`}
      aria-label={`Application ${d.planning_reference}`}
      role="dialog"
    >
      {isMobile && (
        <div className="sheet-grabber" aria-hidden="true"
        >
          <span className="grabber-bar" />
        </div>
      )}
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
            numUnits={d.num_residential_units}
          />
        </div>
        <div className="sheet-actions">
          <ShareLink detail={d} />
          <button type="button" className="sheet-close" onClick={onClose} aria-label="Close application details">
            <XIcon size={13} />
          </button>
        </div>
      </div>

      <header className="detail-header">
        <h2>{d.address_text ?? d.planning_reference}</h2>
        <p className="result-meta">
          <span className="ref">{d.planning_reference}</span> · {d.authority_name}
          {d.received_date && ` · received ${fmtDate(d.received_date)}`}
          {d.is_domestic_guess && (
            <span className="tag" title="Best-effort classification, not an official category">
              likely domestic
            </span>
          )}
        </p>
        {aiSummary ? (
          <p className="ai-summary lead-summary">✦ {aiSummary}</p>
        ) : enrichLoading ? (
          <p className="ai-summary lead-summary loading-line">✦ Writing a summary…</p>
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
        <PropertyMedia lat={d.lat} lng={d.lng} address={d.address_text} />
        <div className="action-row">
          {(!GMAPS_KEY || d.lat == null) && <MapLinks detail={d} />}
          {d.portal_url && (
            <a
              className="btn btn-primary"
              href={d.portal_resolver ? `/api/applications/${d.id}/portal` : d.portal_url}
              target="_blank"
              rel="noopener noreferrer"
            >
              Official {d.authority_short_name} portal ↗
            </a>
          )}
          <button
            type="button"
            className={`save-action ${saved ? "save-action-on" : ""}`}
            onClick={onToggleSave}
          >
            <SaveStar saved={saved} onToggle={onToggleSave} label inline />
          </button>
        </div>
      </header>

      <DecisionSection
        detail={d}
        conditions={conditions}
        conditionsLoading={conditionsLoading}
        conditionsFailed={conditionsFailed}
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
              <span className="tl-date">{step.date ? fmtDate(step.date) : "—"}</span>
            </li>
          ))}
        </ol>
        {/* While the window is open, make the submissions deadline actionable —
            this is the one date a member of the public can still act on. */}
        {!d.decision_date && d.submissions_by_date && !isPast(d.submissions_by_date) && (
          <p className="submissions-open">
            <strong>Open for submissions until {fmtDate(d.submissions_by_date)}</strong>
            {(() => {
              const left = daysUntil(d.submissions_by_date);
              return left === 0 ? " — today is the last day" : ` — ${left} day${left === 1 ? "" : "s"} left`;
            })()}
            . Observations are made to {d.authority_name}, usually with a fee.
          </p>
        )}
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
          {(enrich?.officer_name ?? d.officer_name) && (
            <>
              <dt>Case officer</dt>
              <dd>{enrich?.officer_name ?? d.officer_name}</dd>
            </>
          )}
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
        <section aria-labelledby="related-h">
          <h3 id="related-h">Other applications at this address</h3>
          {d.related.length > 0 ? (
            <ul className="related-list">
              {d.related.map((r) => (
                <li key={r.id} className="related-item">
                  <div className="related-top">
                    <button
                      type="button"
                      className="link-btn ref"
                      onClick={() => onSelectRelated(r.id)}
                    >
                      {r.planning_reference}
                    </button>
                    {r.status && STATUS_STYLE[r.status] && (
                      <StatusBadge status={r.status} label={STATUS_STYLE[r.status].label} />
                    )}
                    {r.received_date && (
                      <span className="related-date">received {fmtDate(r.received_date)}</span>
                    )}
                    {r.decision_date && (
                      <span className="related-date">decided {fmtDate(r.decision_date)}</span>
                    )}
                  </div>
                  {r.description && <p className="related-desc">{r.description}</p>}
                </li>
              ))}
            </ul>
          ) : (
            <p className="section-note">None found recorded at this address.</p>
          )}
          {/* Absence here is weaker evidence than it looks, and saying so is the
              difference between a viewer and a trap. */}
          <p className="caveat">
            Matched on the address as each application recorded it, so a differently-worded
            address won't be linked.{" "}
            {/* Naming the actual year beats "outside the register window": for
                Dublin City that is 2019, so most of a house's history can sit
                outside it, and a reader has no way to know that. */}
            {coverageNoteFor(meta, d.authority_id) ??
              "Earlier applications outside the register window held here won't appear either."}{" "}
            Check the council's portal for a property's full history.
          </p>
        </section>
      )}

      <footer className="detail-footer">
        <p className="caveat">
          {/* source_updated_at is when the register itself was last loaded;
              last_synced is only when we built. Prefer the honest one. */}
          Register data as of {meta?.source_updated_at ?? d.last_synced?.slice(0, 10) ?? "unknown"}.
          This is a viewer over public register data — the {d.authority_name} register (and An
          Coimisiún Pleanála for appeals) is the authoritative source.
        </p>
        {/* Printed pages leave the screen behind, so they have to carry their
            own provenance: when, from where, and how current. */}
        <p className="print-stamp">
          Printed {fmtDate(new Date().toISOString().slice(0, 10))} from {window.location.href} ·
          register data as of {meta?.source_updated_at ?? "unknown"} · PlanView is a viewer over
          public register data; the {d.authority_name} register is authoritative.
        </p>
      </footer>
    </aside>
  );
}
