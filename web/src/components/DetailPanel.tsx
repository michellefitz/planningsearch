import { Fragment, useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import {
  api,
  fmtDate,
  type AppDetail,
  type ConditionHighlight,
  type ConditionItem,
  type DecisionConditions,
  type DocumentReason,
  type Meta,
  type ZoningInfo,
} from "../api";
import PropertyMedia, { GMAPS_KEY, MapLinks } from "./PropertyMedia";
import { XIcon } from "./icons";
import { SecondaryPills, StatusBadge } from "./ResultsList";
import { STATUS_STYLE } from "../statusStyle";
import SaveStar from "./SaveStar";
import { itemLabel } from "../../../api/_conditions/labels.mjs";
import { realDecision } from "../../../api/_conditions/decision.mjs";
import { developmentContribution } from "../../../api/_conditions/contribution.mjs";
import { getFloodData } from "../floodData";
import { Waiting } from "../loading";
import { coverageNoteFor } from "../coverage";
import { SHEET_PEEK_FRACTION } from "../sheetMetrics";
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

/**
 * `submissionsBy` is passed in rather than read off the record because only
 * the agile councils publish it, and only on the live portal — the national
 * dataset leaves the column empty for all four, so it arrives with enrichment
 * a moment after the sheet has already painted.
 */
function buildTimeline(d: AppDetail, submissionsBy?: string | null): TimelineStep[] {
  const decided = Boolean(d.decision_date);
  const submissions = d.submissions_by_date ?? submissionsBy ?? null;
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
  if (submissions) {
    steps.push({
      label: "Submissions by",
      date: submissions,
      state: decided || isPast(submissions) ? "done" : "current",
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

/**
 * The NBCO open-data page for one commencement notice.
 *
 * The dataset slug is `bcnccc`, not `bcms` — the earlier link 404'd. The
 * portal's table view honours CKAN's `filters` parameter (an exact match on a
 * datastore column) and ignores `q`, so filtering on CN_Number is what
 * actually lands the reader on their notice rather than on 300k rows.
 */
export const BCMS_RESOURCE_ID = "0774e781-7af8-46da-b623-872e74cf541e";

export function bcmsNoticeUrl(notice: string): string {
  const filters = encodeURIComponent(`CN_Number:${notice}`);
  return `https://data.nbco.gov.ie/dataset/bcnccc/resource/${BCMS_RESOURCE_ID}?filters=${filters}`;
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

/**
 * A decision that refuses, in whole or in part. Split decisions ("grant for
 * retention and refuse permission for…") count: they carry real refusal
 * grounds, so they must read as a refusal wherever reasons are shown.
 */
export function isRefusalDecision(decision: string | null | undefined): boolean {
  return /refus/i.test(decision ?? "");
}

/**
 * Prescription codes on the council's decision, in display order.
 *
 * `R` is the portal's "Reason" code and it means opposite things either side
 * of the outcome: on a refusal it carries the grounds for refusing, but on a
 * grant it is the First Schedule "Reasons and Considerations" — the council
 * setting out why permission *was* given. Labelling it "Reasons for refusal"
 * on a grant told readers an application had been refused when it hadn't.
 */
function conditionGroups(decision: string | null | undefined, superseded = false) {
  return [
    {
      code: "R",
      label: isRefusalDecision(decision) ? "Reasons for refusal" : "Reasons & considerations",
      blurb: isRefusalDecision(decision)
        // Not always the council's own grounds: on an appealed case the portal
        // files An Coimisiún Pleanála's reasons here too (Dublin City stamps
        // them "ACP Reason"), so naming the council was simply wrong.
        ? "The grounds given for refusal."
        : "The First Schedule of the decision order — why the council considered the development acceptable.",
    },
    {
      code: "C",
      label: superseded ? "Conditions the council had attached" : "Conditions of this decision",
      /**
       * "Binding" is a claim about a live permission. DLR D07B/0746 was
       * granted by the council and refused by An Coimisiún Pleanála on
       * appeal — nothing about it binds anyone, and nothing is payable, yet
       * the page said both. The status badge already reads the appeal; this
       * is the same fact reaching the rest of the sheet.
       */
      blurb: superseded
        ? "Not in force — the council's decision was superseded, so none of these apply."
        : "Binding — the permission only stands if these are met.",
    },
    { code: "D", label: "Further information the council asked for", blurb: null },
    { code: "I", label: "Clarifications & informatives", blurb: null },
    {
      code: "N",
      label: "Notes",
      blurb:
        "Advisory only, not conditions. They point out other consents and laws that still apply — building regulations, Uisce Éireann, a neighbour's agreement — none of which this permission grants.",
    },
  ];
}

// Councils with a structured conditions API — their decision substance comes
// from the conditions endpoint. Everywhere else (eplanning/iDocs councils)
// the reasons live only in the scanned decision order.
const AGILE_CONDITION_AUTHORITIES = new Set(["south-dublin", "dublin-city", "fingal", "dlr"]);

const conditionAnchor = (n: number) => `condition-${n}`;

/**
 * The point of the whole feature: a permission can be granted and still not
 * allow what was drawn. These are the conditions that bind — a narrower
 * entrance, a window that has to be obscured, a dormer dropped below the
 * ridge — lifted out of a list that is otherwise near-identical on every
 * decision. Each one links to the condition it came from, because the wording
 * is what the applicant is actually held to.
 */
function ConditionHighlights({
  highlights,
  loading,
  total,
}: {
  highlights: ConditionHighlight[] | null;
  loading: boolean;
  total: number;
}) {
  if (loading)
    return (
      <Waiting
        active
        className="ai-summary highlights-loading loading-line"
        stages={[
          [0, "✦ Reading the conditions…"],
          [12, "✦ Still reading — working out which ones actually bind."],
          [30, "✦ Still going. Some decisions carry twenty conditions."],
        ]}
      />
    );
  // null is "we couldn't read them" — saying "nothing notable" there would be
  // a claim we haven't earned, and this is exactly where a false all-clear
  // costs someone money.
  if (!highlights || !highlights.length) return null;

  // The API sorts these too, but highlights are cached per decision, so rows
  // read before the sort landed would still arrive in the model's order.
  const ordered = [...highlights].sort((a, b) => a.n - b.n);

  const open = (n: number) => {
    const el = document.getElementById(conditionAnchor(n));
    if (!(el instanceof HTMLDetailsElement)) return;
    el.open = true;
    el.scrollIntoView({ behavior: "smooth", block: "center" });
  };

  const rest = total - highlights.length;
  return (
    <div className="cond-highlights">
      <h4>
        <span className="ai-mark">✦</span> Notable conditions
      </h4>
      <ul>
        {ordered.map((h) => (
          <li key={h.n}>
            <button type="button" className="cond-jump" onClick={() => open(h.n)}>
              <span className="condition-num">{h.n}</span>
              <span>{h.point}</span>
            </button>
          </li>
        ))}
      </ul>
      {rest > 0 && (
        <p className="cond-highlights-rest">
          The other {rest} condition{rest === 1 ? " is" : "s are"} the council's standard wording.
        </p>
      )}
      {/* Read from the decision by a model. The conditions below are the
          binding text — this is a way in, not a substitute for them. */}
      <p className="cond-highlights-note">
        Picked out automatically. Always read the full condition before relying on it.
      </p>
    </div>
  );
}

/** The full conditions / reasons, grouped and collapsible. */
/**
 * On a split decision Dublin City files the two halves as an "Informative" and
 * a "Note", and each one says in its own words which it is: "It is recommended
 * that permission is refused for the provision of three new flags…", "It is
 * recommended the planning permission is GRANTED for the construction of a new
 * first floor…". Checked against five Dublin City split decisions; DLR's use
 * neither code.
 *
 * Read rather than assumed, because the codes carry the opposite meaning on an
 * ordinary decision, and mislabelling them is worse than leaving them alone:
 * the refused half was filed under "Clarifications & informatives" and the
 * granted half under "Notes — Advisory only, not conditions", so the page
 * called the part of the scheme that was actually permitted advisory, and hid
 * the refusal that a buyer most needs to see. 22 Rathgar Road's refused
 * vehicular access — the driveway as built has no permission — was in there.
 */
function splitHalf(items: ConditionItem[]): { label: string; blurb: string } | null {
  const text = items.map((i) => i.text ?? "").join(" ");
  if (/\brefus/i.test(text) && !/\bgrant/i.test(text)) {
    return {
      label: "Refused part of this decision",
      blurb: "This part of the proposal was not permitted.",
    };
  }
  if (/\bgrant/i.test(text) && !/\brefus/i.test(text)) {
    return {
      label: "Granted part of this decision",
      blurb: "This part of the proposal was permitted, subject to the conditions above.",
    };
  }
  return null;
}

/** "Split Decision", "Grant Permission & Refuse Permission" and the rest. */
function isSplitDecision(decision: string | null | undefined): boolean {
  const d = String(decision ?? "");
  return /split\s*decision/i.test(d) || (/grant|permission/i.test(d) && /refus/i.test(d));
}

function ConditionGroups({
  conditions,
  decision,
  superseded = false,
}: {
  conditions: DecisionConditions;
  decision: string | null;
  superseded?: boolean;
}) {
  const split = isSplitDecision(decision);
  const groups = conditionGroups(decision, superseded)
    .map((g) => {
      const items = conditions.items.filter((i) => i.code === g.code);
      // Only where the wording settles it; otherwise the ordinary label stands.
      const half = split && (g.code === "I" || g.code === "N") ? splitHalf(items) : null;
      return { ...g, items, ...(half ?? {}) };
    })
    .filter((g) => g.items.length > 0);

  return (
    <>
      {groups.map((g) => (
        <div key={g.code} className="condition-group">
          <h4>
            {g.label} <span className="count">{g.items.length}</span>
          </h4>
          {/* These headings are planning jargon, and "Notes" in particular
              reads as though the council imposed something. Say what the
              group actually is before the reader opens any of it. */}
          {g.blurb && <p className="condition-blurb">{g.blurb}</p>}
          {g.items.map((item, i) => {
            const num = item.order || i + 1;
            // Portals often give a prescription no title of its own — every
            // reason on an appealed Dublin City case arrives as "ACP Reason",
            // so the list read "ACP Reason 1…4" and had to be opened to learn
            // anything. Derive a label from the wording in that case.
            const title = itemLabel(item, num);
            return (
              <details
                key={`${g.code}-${item.order}-${i}`}
                className="condition"
                // A highlight above links down to the condition it came from,
                // so every condition needs a stable anchor.
                id={g.code === "C" ? conditionAnchor(num) : undefined}
              >
                <summary>
                  <span className="condition-num">{num}</span>
                  {title}
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

/**
 * What to say when the council's own document defeats us.
 *
 * Never "there are no conditions": we do not know that, and on a decision it
 * is the one wrong thing that costs money. Each of these says what stopped us
 * and where the answer is instead.
 */
function unreadableNote(
  reason: DocumentReason | null,
  document: string | null,
  council: string
): ReactNode {
  const named = document ? <> — <em>{document}</em></> : null;
  switch (reason) {
    case "djvu":
      // These are decoded now — reaching this means the decode itself failed,
      // which is a fault on our side and worth saying so.
      return (
        <>
          Couldn't read the scanned decision order{named}. This does <strong>not</strong> mean
          there are no conditions — the order is on {council}'s viewer below.
        </>
      );
    case "too_large":
      return (
        <>
          The decision order{named} is too large to read here. It is on {council}'s viewer below.
        </>
      );
    case "not_found":
      return <>No decision order on the council's file list — the documents below are all of it.</>;
    case "unreadable_format":
      return (
        <>
          The decision order{named} isn't in a format that can be read here. Open it on {council}'s
          viewer below.
        </>
      );
    default:
      return (
        <>
          Couldn't read the decision order just now. This does <strong>not</strong> mean there are
          no conditions — they are on {council}'s viewer below.
        </>
      );
  }
}

/** The same, for the further-information request rather than the decision. */
function unreadableRequestNote(
  reason: DocumentReason,
  document: string | null,
  council: string
): ReactNode {
  const named = document ? <> — <em>{document}</em></> : null;
  if (reason === "djvu")
    return (
      <>
        Couldn't read the scanned request letter{named} — it is on {council}'s viewer below.
      </>
    );
  if (reason === "too_large")
    return (
      <>
        The request letter{named} is too large to read here. It is on {council}'s viewer below.
      </>
    );
  return (
    <>
      Couldn't read the request letter{named} just now — it is on {council}'s viewer below.
    </>
  );
}

type DecisionOrderState =
  | { phase: "idle" }
  | { phase: "loading" }
  | { phase: "failed" }
  | { phase: "empty"; reason: DocumentReason | null; document: string | null }
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
      else
        setState({
          phase: "empty",
          reason: res.reason ?? null,
          document: res.source_document ?? null,
        });
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
      <Waiting
        active={state.phase === "loading"}
        stages={[
          [0, "Reading the council's decision order…"],
          [10, "Still reading — it is a scanned document, so this is slow."],
          [30, "Still going. Nearly there."],
        ]}
      />
      {state.phase === "failed" && (
        <>
          <p className="list-note">Couldn't read the decision order just now.</p>
          <button type="button" className="btn ai" onClick={load}>
            ✦ Try again
          </button>
        </>
      )}
      {state.phase === "empty" && (
        <p className="section-note section-note-warn">
          {unreadableNote(state.reason, state.document, d.authority_short_name)}
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
          {/* Which document this came from is the useful half and stays; the
              "verify before relying on it" half is said once, in the footer. */}
          <p className="list-note">
            AI-extracted from "{state.source ?? "the decision order"}".
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
 * The appeal, told inside the decision section: the AI summary of the case,
 * the national record, and the deep link to the file. Status/dates live in the
 * timeline and facts, so they aren't repeated here.
 *
 * Both the summary and the case record load themselves once this scrolls into
 * view. Pressing a button to see the appeal bought nothing — nobody opens an
 * appealed application and decides they would rather not read the appeal — and
 * it was the last thing in the sheet still asking. It is still not fetched on
 * open: An Coimisiún Pleanála's record is a live round-trip to their servers,
 * so it fires for pages someone actually scrolled to.
 */
function AppealBlock({ detail: d }: { detail: AppDetail }) {
  const [state, setState] = useState<AppealState>({ phase: "idle" });
  const [summary, setSummary] = useState<SummaryState>({ phase: "idle" });
  const rootRef = useRef<HTMLDivElement>(null);
  const loadRef = useRef<() => void>(() => {});
  useEffect(() => {
    setState({ phase: "idle" });
    setSummary({ phase: "idle" });
  }, [d.id]);

  useEffect(() => {
    const el = rootRef.current;
    if (!el || typeof IntersectionObserver === "undefined") return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          io.disconnect();
          loadRef.current();
        }
      },
      { rootMargin: "300px" }
    );
    io.observe(el);
    return () => io.disconnect();
  }, [d.id]);

  const load = async () => {
    setState((s) => (s.phase === "idle" ? { phase: "loading" } : s));
    setSummary((s) => (s.phase === "idle" ? { phase: "loading" } : s));
    // Two independent round-trips — the case record comes from An Coimisiún
    // Pleanála, the summary from the model — so one failing must not blank the
    // other.
    void api
      .appeal(d.id)
      .then((res) => {
        if (res.fields?.length || res.documents?.length)
          setState({ phase: "loaded", fields: res.fields ?? [], documents: res.documents ?? [] });
        else setState({ phase: "empty" });
      })
      .catch(() => setState({ phase: "failed" }));
    void api
      .appealSummary(d.id)
      .then((res) => {
        if (res.summary)
          setSummary({ phase: "loaded", summary: res.summary, source: res.based_on_document ?? null });
        else setSummary({ phase: "empty" });
      })
      .catch(() => setSummary({ phase: "failed" }));
  };

  loadRef.current = load;

  if (!d.appeal_reference) return null;

  return (
    <div className="appeal-block" ref={rootRef}>
      <h4>
        Appeal <span className="count">{appealRef(d)}</span>
      </h4>

      {(summary.phase === "idle" || summary.phase === "loading") && (
        <div className="appeal-summary-skeleton" aria-hidden="true">
          <span /><span /><span />
        </div>
      )}
      {summary.phase === "failed" && (
        <p className="list-note">Couldn't generate a summary just now — try again shortly.</p>
      )}
      {summary.phase === "empty" && (
        <p className="list-note">Not enough on the case file yet to summarise.</p>
      )}
      {summary.phase === "loaded" && (
        /* The star marks it as model-written, in the same place as every other
           AI line in the sheet. It used to say so in a footer underneath,
           which took a line to repeat what the mark says at a glance. */
        <p className="ai-summary">
          <span className="ai-mark">✦</span> {summary.summary}
        </p>
      )}

      {/* Held open at the height of a case record — four documents is the usual
          count — so the link below it doesn't jump down the page when the
          record arrives. */}
      {(state.phase === "idle" || state.phase === "loading") && (
        <div className="doc-placeholder appeal-placeholder">
          <div className="doc-skeleton" aria-hidden="true">
            <span /><span /><span /><span />
          </div>
          <Waiting
            active
            stages={[
              [0, "Fetching the national case record…"],
              [8, "Still fetching — An Coimisiún Pleanála's site is slow to answer."],
              [20, "Still going."],
            ]}
          />
        </div>
      )}
      {state.phase === "failed" && (
        <p className="list-note">
          Couldn't reach An Coimisiún Pleanála just now — use the case-file link below.
        </p>
      )}
      {state.phase === "empty" && (
        <p className="list-note">
          Nothing extra to show — the case file below has the full national record.
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
      {/* Last, as the council's file viewer is in the documents section: the
          way out to the full record, after everything we can show inline. */}
      {d.appeal_url && (
        <a className="link-btn viewer-link" href={d.appeal_url} target="_blank" rel="noopener noreferrer">
          Case file on An Coimisiún Pleanála ↗
        </a>
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

function ContributionLine({ conditions }: { conditions: DecisionConditions | null }) {
  const c = conditions ? developmentContribution(conditions.items) : null;
  if (!c) return null;
  const money = c.total.toLocaleString("en-IE", {
    style: "currency",
    currency: "EUR",
    minimumFractionDigits: c.total % 1 === 0 ? 0 : 2,
  });
  return (
    <p className="commencement-line contribution-line">
      {money} in development contributions payable
      <span className="hint"> · condition {c.condition}</span>
    </p>
  );
}

/**
 * What the council has asked for before it will decide.
 *
 * This used to render as a Decision: the portals file the request in the same
 * field as the outcome, so an application still under assessment showed
 * "Seek Clarification Of Additional Information" under a Decision heading,
 * with a button offering to summarise a decision that does not exist. The
 * request is genuinely the most useful thing on the file at this point — it is
 * what the applicant has to fix — so it gets said properly instead.
 */
function FurtherInfoSection({
  detail: d,
  conditions,
  conditionsLoading,
  askedSummary,
  askedLoading,
  askedReason,
}: {
  detail: AppDetail;
  conditions: DecisionConditions | null;
  conditionsLoading: boolean;
  askedSummary: string | null;
  askedLoading: boolean;
  askedReason: { reason: DocumentReason | null; document: string | null } | null;
}) {
  // The portal's decision_date is when the request issued only while the file
  // is actually at that stage; on a decided application it is the decision's
  // own date, which is how "asked 15 Jul 2022" appeared under a decision made
  // on 15 Jul 2022.
  const requested =
    d.further_info_requested_date ?? (conditions?.further_info ? conditions.decision_date : null);
  /**
   * Dated rows rather than a sentence.
   *
   * This used to read "Meath asked the applicant for more, and has it" — which
   * says in nine words what "Received · 24 Mar 2020" says exactly, directly
   * under a timeline that had already given both dates. A list also leaves
   * room for the second round these files often have: an application can go
   * out for further information twice, and the register holds one date each
   * today, so the shape is here even where the data is not yet.
   */
  const rounds: Array<{ label: string; date: string | null }> = [
    ...(requested ? [{ label: "Requested", date: requested }] : []),
    ...(d.further_info_received_date
      ? [{ label: "Received", date: d.further_info_received_date }]
      : []),
  ];
  return (
    <section aria-labelledby="further-info-h" aria-busy={conditionsLoading || undefined}>
      <h3 id="further-info-h">Further information</h3>
      <div className="decision-lines">
        {rounds.map((r) => (
          <p className="decision-line" key={`${r.label}-${r.date}`}>
            {r.label}
            {r.date && <span className="hint"> · {fmtDate(r.date)}</span>}
          </p>
        ))}
        {!d.further_info_received_date && (
          <p className="decision-line">
            <span className="hint">Awaiting the applicant's response</span>
          </p>
        )}
      </div>
      {askedSummary ? (
        <p className="ai-summary">
          <span className="ai-mark">✦</span> {askedSummary}
        </p>
      ) : (
        <Waiting
          active={askedLoading}
          className="ai-summary loading-line"
          stages={[
            [0, "✦ Reading what was asked for…"],
            [12, "✦ Still reading — the request is a scanned letter."],
            [30, "✦ Still going. These letters run to several pages."],
          ]}
        />
      )}
      {conditionsLoading && (
        <>
          <Waiting
            active
            stages={[
              [0, `Fetching the request from ${d.authority_short_name}…`],
              [12, "Still fetching — the council's portal is slow to answer."],
            ]}
          />
          <div className="skeleton-block" aria-hidden="true">
            <span />
            <span />
            <span />
          </div>
        </>
      )}
      {conditions && conditions.items.length > 0 && (
        <ConditionGroups conditions={conditions} decision={null} />
      )}
      {/* Kildare, Wicklow and Meath publish no structured conditions — their
          request is a scanned letter, summarised above from the PDF. The
          letter itself is in the documents section below. */}
      {!conditions && !askedLoading && !askedSummary && (
        <p className="section-note">
          {askedReason?.reason && askedReason.reason !== "not_found" ? (
            unreadableRequestNote(askedReason.reason, askedReason.document, d.authority_short_name)
          ) : (
            <>
              {d.authority_short_name} publishes the request as a letter on the file rather than as
              structured text — look for it in the documents below.
            </>
          )}
        </p>
      )}
    </section>
  );
}

function DecisionSection({
  detail: d,
  conditions,
  conditionsLoading,
  conditionsFailed,
  refusalSummary,
  refusalLoading,
  highlights,
  highlightsLoading,
}: {
  detail: AppDetail;
  conditions: DecisionConditions | null;
  conditionsLoading: boolean;
  conditionsFailed: boolean;
  refusalSummary: string | null;
  refusalLoading: boolean;
  highlights: ConditionHighlight[] | null;
  highlightsLoading: boolean;
}) {
  const decision = conditions?.decision ?? d.decision;
  const decisionDate = conditions?.decision_date ?? d.decision_date;
  const hasAppeal = Boolean(d.appeal_reference || d.appeal_decision);
  if (!decision && !hasAppeal) return null;
  // eplanning/iDocs councils record their reasons only in the scanned
  // decision order — offer the on-demand PDF summary instead of conditions.
  const scannedOrderOnly =
    Boolean(d.decision && d.scanned_files_url) && !AGILE_CONDITION_AUTHORITIES.has(d.authority_id);
  // The red "Refused because…" line belongs to a refusal — by the council or
  // by the Commission on appeal. On a grant the same reasons are the First
  // Schedule, and a refusal-shaped sentence about them is simply wrong.
  const refused = isRefusalDecision(decision) || isRefusalDecision(d.appeal_decision);
  /**
   * The Commission's decision replaces the council's, so a grant that was
   * refused on appeal leaves nothing standing. The status badge has always
   * read the appeal; the conditions block and the contribution line did not,
   * and between them they told a reader that a permission which does not
   * exist was binding and that money was payable on it (DLR D07B/0746,
   * granted 2007, refused by the Board in June 2008, €696.37 "payable").
   */
  const superseded =
    Boolean(d.appeal_decision) &&
    !isRefusalDecision(decision) &&
    isRefusalDecision(d.appeal_decision);
  const summary = refused ? conditions?.refusal_summary ?? refusalSummary : null;

  return (
    <section aria-labelledby="decision-h" aria-busy={conditionsLoading || undefined}>
      <h3 id="decision-h">Decision</h3>
      {decision && (
        <div className="decision-lines">
          <p className="decision-line">
            <span className={outcomeClass(decision)}>{titleCase(decision)}</span>
            {decisionDate && <span className="hint"> · {fmtDate(decisionDate)}</span>}
          </p>
          {d.appeal_decision && (
            <p className="decision-line">
              <span className={outcomeClass(d.appeal_decision)}>
                {titleCase(d.appeal_decision)}
              </span>
              <span className="hint"> on appeal</span>
              {d.appeal_decision_date && <span className="hint"> · {fmtDate(d.appeal_decision_date)}</span>}
            </p>
          )}
        </div>
      )}
      {d.commencement_date ? (
        <p className="commencement-line">
          {d.commencement_date > new Date().toISOString().slice(0, 10)
            ? "Work due to commence on site"
            : "Work has commenced on site"}
          <span className="hint"> · {fmtDate(d.commencement_date)}</span>
          {d.commencement_notice && (
            <span className="hint">
              {" · notice "}
              <a
                href={bcmsNoticeUrl(d.commencement_notice)}
                target="_blank"
                rel="noopener noreferrer"
              >
                {d.commencement_notice}
              </a>
            </span>
          )}
          {d.completion_date && (
            <span className="hint"> · completion certified {fmtDate(d.completion_date)}</span>
          )}
        </p>
      ) : null}
      {/* Not a "notable condition" — it is on roughly two permissions in five
          and changes nothing about what can be built — but it is the one
          number in the decision people ask for, so it is stated as a fact.
          Totalled in code, since councils split it across several conditions
          and no single one carries the sum. */}
      {/* Nothing is payable on a permission the Commission refused. */}
      {!superseded && <ContributionLine conditions={conditions} />}
      {summary ? (
        <p className="ai-summary refusal-summary">✦ {summary}</p>
      ) : (
        refused &&
        refusalLoading && (
          <Waiting
            active
            className="ai-summary refusal-summary loading-line"
            stages={[
              [0, "✦ Summarising the reasons for refusal…"],
              [12, "✦ Still working — reading the full wording."],
            ]}
          />
        )
      )}
      {/* This was three grey bars and nothing else. On Dublin City the
          conditions come out of a scanned decision order and can take over a
          minute, and an unlabelled skeleton for that long reads as an
          unconditional grant — the most expensive thing this sheet could
          imply. */}
      {conditionsLoading && (
        <>
          <Waiting
            active
            stages={[
              [0, `Reading the conditions from ${d.authority_short_name}…`],
              [10, "Still reading — the decision order is a scanned document."],
              [30, "Still going. Long decisions take a while to read."],
            ]}
          />
          <div className="skeleton-block" aria-hidden="true">
            <span />
            <span />
            <span />
          </div>
        </>
      )}
      {conditions && conditions.items.length > 0 && (
        <>
          <ConditionHighlights
            highlights={highlights}
            loading={highlightsLoading}
            total={conditions.items.filter((i) => i.code === "C").length}
          />
          <ConditionGroups conditions={conditions} decision={decision} superseded={superseded} />
        </>
      )}
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

/** The ceiling on a serverless response body — matches the API's own cap. */
const MAX_PROXY_BYTES = 4_000_000;

const fmtBytes = (n: number) =>
  n >= 1024 ** 2 ? `${Math.round(n / 1024 ** 2)} MB` : `${Math.round(n / 1024)} KB`;

type FilesState =
  | { phase: "idle" }
  | { phase: "loading" }
  | {
      phase: "loaded";
      files: Array<{ title: string; url: string; size?: number }>;
      objections: number;
      direct: boolean;
    }
  | { phase: "failed" };

function ScannedFiles({ detail: d }: { detail: AppDetail }) {
  const [state, setState] = useState<FilesState>({ phase: "idle" });
  const rootRef = useRef<HTMLDivElement>(null);
  const loadRef = useRef<() => void>(() => {});
  useEffect(() => setState({ phase: "idle" }), [d.id]);

  /**
   * Fetch the list once this section is scrolled to.
   *
   * Listing files costs nothing but an HTTP round-trip to the council's own
   * portal — no model call — so making the reader press a button for it bought
   * nothing. It is still not fetched on open: it is the last section on a long
   * sheet, and firing it for every application anyone glances at would put
   * traffic on council servers for pages nobody scrolled to.
   */
  useEffect(() => {
    const el = rootRef.current;
    if (!el || typeof IntersectionObserver === "undefined") return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          io.disconnect();
          loadRef.current();
        }
      },
      { rootMargin: "300px" }
    );
    io.observe(el);
    return () => io.disconnect();
  }, [d.id]);

  if (!d.scanned_files_url && !d.files_supported) return null;

  const load = async () => {
    // Anything but a list already on screen goes back to waiting — the guard
    // used to admit only "idle", so pressing Try again refetched but left the
    // failure notice up, and the retry looked like it had done nothing.
    setState((s) => (s.phase === "loaded" ? s : { phase: "loading" }));
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

  loadRef.current = load;

  // Every document on the file being one we cannot carry is a fact about the
  // file, not about each row of it. Only size does that now.
  const allAtCouncil =
    state.phase === "loaded" &&
    state.files.length > 1 &&
    state.files.every((f) => typeof f.size === "number" && f.size > MAX_PROXY_BYTES);

  return (
    <div className="scanned-files" ref={rootRef}>
      {/* Idle and loading look the same now: the list starts fetching as this
          scrolls into view, so the skeleton is a progress indicator rather
          than something waiting to be pressed. The wording moves on as the
          wait does, because a message that has not changed in twenty seconds
          is the thing people read as broken. */}
      {(state.phase === "idle" || state.phase === "loading") && (
        <div className="doc-placeholder">
          <div className="doc-skeleton" aria-hidden="true">
            <span /><span /><span /><span />
          </div>
          <Waiting
            active
            stages={[
              [0, `Fetching the file list from ${d.authority_short_name}…`],
              [6, `Still fetching — ${d.authority_short_name}'s portal is slow to answer.`],
              [18, "Still going. The council's own site is the slow part here."],
            ]}
          />
        </div>
      )}
      {state.phase === "failed" && (
        <div className="doc-failed">
          <p className="list-note">
            Couldn't load the file list from {d.authority_short_name} just now. This does{" "}
            <strong>not</strong> mean there are no documents.
          </p>
          <button type="button" className="btn" onClick={load}>
            Try again
          </button>
        </div>
      )}
      {state.phase === "loaded" && state.objections > 0 && (
        <p className="objection-flag">
          {state.objections} third-party submission{state.objections === 1 ? "" : "s"} /
          objection{state.objections === 1 ? "" : "s"} on file
        </p>
      )}
      {/* When every document on the file is out of reach, saying so once is
          better than saying it on every row. A file with one oversized drawing
          keeps the per-row note, which is where it belongs. */}
      {state.phase === "loaded" && allAtCouncil && (
        <p className="list-note">
          These are larger than can be passed through here. Each one opens on{" "}
          {d.authority_short_name}'s own viewer below.
        </p>
      )}
      {state.phase === "loaded" && (
        <ul className="doc-list">
          {state.files.map((f, i) => {
            // Nearly a third of the documents on a busy Kildare file are over
            // the four-megabyte ceiling a serverless response can carry — one
            // photo montage is nineteen. Clicking those used to load a page
            // saying so; the listing prints the size, so it can be said before
            // the click instead of after it.
            const tooBig = typeof f.size === "number" && f.size > MAX_PROXY_BYTES;
            // `viewer_only` used to send the older DjVu scans to the council,
            // because nothing here could draw one. They are decoded and served
            // as PDFs now, so size is the only thing left that puts a document
            // out of reach.
            const onlyAtCouncil = tooBig && Boolean(d.scanned_files_url);
            return (
              <li key={f.url}>
                {/* direct=true (Agile): stable download URLs, link straight
                    out. Otherwise (iDocs): session-bound URLs, proxied through
                    our API so each click is self-contained. A file we cannot
                    carry goes to the council's own viewer, which can. */}
                <a
                  href={
                    onlyAtCouncil
                      ? d.scanned_files_url!
                      : state.direct
                        ? f.url
                        : `/api/applications/${d.id}/files/${i}`
                  }
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  {f.title}
                </a>
                {onlyAtCouncil && (tooBig || !allAtCouncil) && (
                  <span className="hint doc-size">
                    {tooBig ? ` · ${fmtBytes(f.size!)}` : ""} · opens on{" "}
                    {d.authority_short_name}'s viewer
                  </span>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

/**
 * The way in to the council's own documents, which is not conditional on
 * anything of ours working.
 *
 * It used to sit inside the file list, so a council we hold no listing for —
 * every Meath application with a lettered reference, until the regex above was
 * fixed — got a sheet that said "use the portal link above" over no link at
 * all, and a failed fetch took the link down with it. The list is a
 * convenience; this is the source, and it is always here.
 */
function DocumentSource({ detail: d }: { detail: AppDetail }) {
  const href = d.scanned_files_url ?? d.portal_url;
  if (!href) return null;
  return (
    <a className="link-btn viewer-link" href={href} target="_blank" rel="noopener noreferrer">
      {d.scanned_files_url
        ? `Open ${d.authority_short_name}'s file viewer ↗`
        : `Open this application on ${d.authority_short_name}'s portal ↗`}
    </a>
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
  const [conditions, setConditions] = useState<DecisionConditions | null>(null);
  const [conditionsLoading, setConditionsLoading] = useState(false);
  // A council portal that didn't answer must never look like a permission with
  // no conditions attached — those are opposite facts. Track the outcome of the
  // fetch, not just whether we ended up with rows.
  const [conditionsFailed, setConditionsFailed] = useState(false);
  const [refusalSummary, setRefusalSummary] = useState<string | null>(null);
  const [refusalLoading, setRefusalLoading] = useState(false);
  const [askedSummary, setAskedSummary] = useState<string | null>(null);
  const [askedLoading, setAskedLoading] = useState(false);
  /* Why there is no summary, when there is none — the scanned letter can be
     absent, oversized, or a DjVu the model cannot read, and each of those is
     something different from "nothing was asked for". */
  const [askedReason, setAskedReason] = useState<{
    reason: DocumentReason | null;
    document: string | null;
  } | null>(null);
  const [highlights, setHighlights] = useState<ConditionHighlight[] | null>(null);
  const [highlightsLoading, setHighlightsLoading] = useState(false);
  const [enrich, setEnrich] = useState<{
    ai_summary: string | null;
    summary_status?: "ok" | "insufficient" | "unavailable";
    applicant_name: string | null;
    agent_name: string | null;
    description?: string | null;
    eircode?: string | null;
    officer_name?: string | null;
    submissions_by_date?: string | null;
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
  /**
   * The live portal status, whenever enrichment offers one.
   *
   * This used to be taken only when the baked status was "unknown", which
   * threw away every correction the API had already decided was safe. The
   * endpoint does the judging: it returns `status` only when the portal shows
   * a terminal outcome the national dataset has not caught up to, and never
   * overrides an outcome that is already recorded. Dublin City WEB2660/26 was
   * withdrawn on 10 August and still read "Pending decision · Decision due 27
   * Aug" nine days later — the correction was in the response the whole time.
   */
  const liveStatus = enrich?.status ?? null;
  /**
   * Statuses where the file is closed and there is nothing left to say to the
   * council. Anything not on this list is still live — an appeal, further
   * information and a plain pending case all still move.
   */
  const CLOSED = new Set([
    "granted", "refused", "withdrawn", "invalid", "split", "exempt", "not_exempt", "decided",
  ]);
  /**
   * Is the application still open to the public?
   *
   * Three independent signals, because each of them has been wrong on its own:
   * the baked status lags the council by months, the live portal status is the
   * correction for that, and the portal's conditions payload carries an
   * outcome the status field sometimes still hides. Any one of them saying the
   * file is closed is enough — the cost of wrongly inviting a submission is
   * someone paying a fee and writing to the council about a decided or
   * withdrawn application, which is exactly what happened with Dublin City
   * WEB2660/26: withdrawn on 10 August, still reading "Open for submissions"
   * nine days later.
   */
  const closedDecision = realDecision(conditions?.decision ?? d.decision);
  const stillLive =
    !d.decision_date &&
    !closedDecision &&
    !CLOSED.has(liveStatus ?? d.status);
  // Only the agile councils publish the observation deadline, and only on the
  // live portal — so it arrives with enrichment, after the sheet has painted.
  const submissionsBy = d.submissions_by_date ?? enrich?.submissions_by_date ?? null;
  const timeline = buildTimeline(d, submissionsBy);
  /**
   * Whether the council asked this applicant for more, ever.
   *
   * Not only while it is waiting on the answer, and not only before a decision
   * — a request is the clearest published record of what the planner was
   * worried about, which is exactly what someone reading a granted or refused
   * application wants to know. The agile portals say so in the conditions
   * payload; everywhere else the dates on the record are the signal.
   */
  const hasFurtherInfo =
    Boolean(conditions?.further_info) ||
    // "D" (Directive) is the agile portals' further-information item. "I"
    // used to count too, which was wrong: Dublin City files the two halves of
    // a *split decision* as an Informative and a Note, so every split decision
    // grew a "Further information requested" heading — 4034/22, decided in
    // July 2022, read as still awaiting information four years later.
    Boolean(conditions?.items.some((i) => i.code === "D")) ||
    d.status === "further_info" ||
    Boolean(d.further_info_requested_date);
  // ~65 chars per line at the sheet's width — beyond ~6 lines, clamp.
  const isLongDesc = (description ?? "").length > 400;
  const hasConditionsSource = AGILE_CONDITION_AUTHORITIES.has(d.authority_id);

  useEffect(() => {
    setConditions(null);
    setConditionsFailed(false);
    setRefusalSummary(null);
    setRefusalLoading(false);
    setAskedSummary(null);
    setAskedLoading(false);
    setAskedReason(null);
    setHighlights(null);
    setHighlightsLoading(false);
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
    // Councils with no conditions endpoint carry the request as a scanned
    // letter instead, read on the same endpoint — so the fetch is driven by
    // the status here rather than by anything in a conditions payload that
    // will never arrive.
    if (!hasConditionsSource && (d.status === "further_info" || d.further_info_requested_date)) {
      setAskedLoading(true);
      api
        .furtherInfoSummary(d.id)
        .then((r) => {
          if (cancelled) return;
          setAskedSummary(r.summary ?? null);
          if (!r.summary)
            setAskedReason({ reason: r.reason ?? null, document: r.source_document ?? null });
        })
        .catch(() => {})
        .finally(() => {
          if (!cancelled) setAskedLoading(false);
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
            // there are refusal reasons to summarise. Code "R" alone isn't
            // that: on a grant it is the First Schedule reasons for granting,
            // so the decision has to say "refuse" before we ask.
            if (
              !res.conditions.refusal_summary &&
              isRefusalDecision(res.conditions.decision ?? d.decision) &&
              res.conditions.items.some((i) => i.code === "R")
            ) {
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
            // The council has asked for more before it will decide. The
            // request is already here, as D/I items — several thousand words
            // of planning prose on a house extension — so summarise what is
            // actually being asked for.
            if (
              res.conditions.further_info ||
              res.conditions.items.some((i) => i.code === "D" || i.code === "I")
            ) {
              setAskedLoading(true);
              api
                .furtherInfoSummary(d.id)
                .then((r) => {
                  if (!cancelled) setAskedSummary(r.summary ?? null);
                })
                .catch(() => {})
                .finally(() => {
                  if (!cancelled) setAskedLoading(false);
                });
            }
            // Conditions bind whatever the outcome, so this runs on grants
            // and refusals alike — but only where the council actually
            // imposed some.
            if (res.conditions.items.some((i) => i.code === "C")) {
              setHighlightsLoading(true);
              api
                .conditionHighlights(d.id)
                .then((r) => {
                  if (!cancelled) setHighlights(r.highlights ?? null);
                })
                .catch(() => {})
                .finally(() => {
                  if (!cancelled) setHighlightsLoading(false);
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
  }, [d.id, d.ai_summary, d.applicant_name, d.agent_name, d.decision, hasConditionsSource]);

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
  const peekOffset = () => Math.round(window.innerHeight * SHEET_PEEK_FRACTION);

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
      // Distance and a hard flick both mean "close", and both are checked
      // before the gentle-flick rule below. That rule sent every downward
      // flick from full to the peek height first, so closing from full always
      // took two gestures however far the sheet had been dragged.
      if (y > peek + innerH * 0.12) target = "dismiss";
      else if (vy > 1.2) target = "dismiss";
      // A soft flick from full still stops at the peek — the halfway height is
      // useful, it just shouldn't be compulsory on the way out.
      else if (vy > 0.5) target = expandedRef.current ? "peek" : "dismiss";
      else if (vy < -0.5) target = "full";
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
          <Waiting
            active
            className="ai-summary lead-summary loading-line"
            stages={[
              [0, "✦ Writing a plain-English summary…"],
              [12, "✦ Still writing — the description is a long one."],
            ]}
          />
        ) : (
          // Enrichment ran and produced no usable summary. Which of the two
          // reasons it was matters: "not enough information" is a claim about
          // the council's description, and making it when our own model call
          // had timed out was simply untrue — the description in front of the
          // reader was often several hundred words.
          enrich !== null &&
          description && (
            <p className="ai-summary lead-summary summary-empty">
              {enrich.summary_status === "insufficient"
                ? "Not enough information to generate a summary."
                : "Couldn't write a summary just now — the description is below."}
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

      {/* Timeline first: it is the chronology the decision is the end of,
          so reading the outcome and then scrolling back to how it got there
          ran the story backwards. */}
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
        {stillLive && submissionsBy && !isPast(submissionsBy) && (
          <p className="submissions-open">
            <strong>Open for submissions until {fmtDate(submissionsBy)}</strong>
            {(() => {
              const left = daysUntil(submissionsBy);
              return left === 0 ? " — today is the last day" : ` — ${left} day${left === 1 ? "" : "s"} left`;
            })()}
            . Observations are made to {d.authority_name}, usually with a fee.
          </p>
        )}
        {/* The "confirm time-critical dates on the portal" caveat used to sit
            here. It said what the footer already says, directly under the dates
            it was hedging, on every undecided application — the third such box
            on the page. One statement of provenance at the end covers it. */}
      </section>

      {/* Before the decision, because it happened before it: on a decided
          application the request is the clearest record of what the planner
          was worried about, and reading it after the outcome loses that. */}
      {hasFurtherInfo && (
        <FurtherInfoSection
          detail={d}
          conditions={conditions}
          conditionsLoading={conditionsLoading}
          askedSummary={askedSummary}
          askedLoading={askedLoading}
          askedReason={askedReason}
        />
      )}

      <DecisionSection
        detail={d}
        conditions={conditions}
        conditionsLoading={conditionsLoading}
        conditionsFailed={conditionsFailed}
        refusalSummary={refusalSummary}
        refusalLoading={refusalLoading}
        highlights={highlights}
        highlightsLoading={highlightsLoading}
      />

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
            We don't hold a document list for this application. The drawings, forms, reports and
            decision orders are on {d.authority_name}'s own file.
          </p>
        )}
        <ScannedFiles detail={d} />
        <DocumentSource detail={d} />
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
          {/* The caveat that stood here — address matching and the register
              window — moved to the footer. Absence here is still weaker
              evidence than it looks, which is why it is stated rather than
              dropped; it just doesn't need its own grey box mid-page. */}
        </section>
      )}

      {/* One caveat for the page. The same three points used to appear as
          separate grey boxes beside the timeline, the related applications and
          here — each restating that this is a viewer and to check the portal.
          Repetition stopped them being read; the specifics (which year the
          register starts, that matching is by address string) are what a reader
          actually needs, so those are kept and the rest is said once. */}
      <footer className="detail-footer">
        <p className="caveat">
          {/* source_updated_at is when the register itself was last loaded;
              last_synced is only when we built. Prefer the honest one. */}
          Register data as of {meta?.source_updated_at ?? d.last_synced?.slice(0, 10) ?? "unknown"}.
          This is a viewer over public register data — the {d.authority_name} register (and An
          Coimisiún Pleanála for appeals) is the authoritative source, and the one to confirm
          anything time-critical against, such as an observation deadline. Summaries marked ✦ are
          AI-generated from the documents named beside them. Applications at this address are
          matched on the address as each one recorded it, so a differently-worded address won't be
          linked.{" "}
          {/* Naming the actual year beats "outside the register window": for
              Dublin City that is 2019, so most of a house's history can sit
              outside it, and a reader has no way to know that. */}
          {coverageNoteFor(meta, d.authority_id) ??
            "Earlier applications outside the register window held here won't appear either."}
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
