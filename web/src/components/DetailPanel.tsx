import { Fragment, useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
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
  type RzltInfo,
  type SourceDocument,
} from "../api";
import PropertyMedia, { GMAPS_KEY, MapLinks } from "./PropertyMedia";
import { HistoryIcon, XIcon } from "./icons";
import { SecondaryPills, StatusBadge } from "./ResultsList";
import { STATUS_STYLE } from "../statusStyle";
import SaveStar from "./SaveStar";
import { itemLabel, scheduleConditionCount } from "../../../api/_conditions/labels.mjs";
import { realDecision } from "../../../api/_conditions/decision.mjs";
import { appealOutcome } from "../../../api/_conditions/appeal.mjs";
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
  skipEntrance?: boolean;
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
 * When the public can still write to the council about an application.
 *
 * The one date on the sheet a member of the public can still act on, and it
 * was shown on Kildare and almost nowhere else. Kildare bakes it into the
 * register (39 of 40 live applications carry it); the four agile councils
 * publish it on their portals and it arrives with enrichment, but patchily —
 * sampled live, Dublin City and DLR had it on some applications and Fingal on
 * none; Meath and Wicklow never publish it at all. So the same live
 * application showed a countdown or nothing depending on which county it was
 * in, and the timeline lost a row with it.
 *
 * Article 29 of the Planning and Development Regulations 2001 gives five weeks
 * from the date the authority received the application, so the date is derived
 * where it is not published — and says so, because a statutory default is not
 * the same thing as the council's own published date.
 *
 * Not derived once further information is in play. Significant further
 * information reopens the window on a fresh newspaper notice whose date we do
 * not hold, so five weeks from receipt is simply the wrong answer there — and
 * a confidently wrong deadline on the one date someone might act on is worse
 * than none.
 */
const SUBMISSION_WEEKS = 5;

export function submissionsDeadline(
  d: Pick<AppDetail, "submissions_by_date" | "received_date" | "further_info_requested_date">,
  fromEnrich?: string | null
): { date: string; source: "published" | "statutory" } | null {
  const published = d.submissions_by_date ?? fromEnrich ?? null;
  if (published) return { date: published, source: "published" };
  if (!d.received_date || d.further_info_requested_date) return null;
  const from = new Date(`${d.received_date}T00:00:00`);
  if (Number.isNaN(from.getTime())) return null;
  from.setDate(from.getDate() + SUBMISSION_WEEKS * 7);
  return { date: from.toISOString().slice(0, 10), source: "statutory" };
}

/**
 * `submissionsBy` is passed in rather than read off the record because the
 * councils that publish it do so only on the live portal — the national
 * dataset leaves the column empty, so it arrives with enrichment a moment
 * after the sheet has already painted.
 */
/**
 * Statuses that end the file without a decision.
 *
 * A withdrawn or invalid application will never be decided, so the steps that
 * lead to one are not "still to come" — they are never coming. Dublin City
 * WEB2660/26 was withdrawn on 10 August and its timeline still read "Decision
 * due 27 Aug" nine days later, with the submissions row above it open.
 */
const ENDED_WITHOUT_DECISION: Record<string, string> = {
  withdrawn: "Withdrawn by the applicant",
  invalid: "Rejected as invalid",
};

/**
 * `liveStatus` is the portal's answer where enrichment has one, because the
 * baked register lags it — sometimes by weeks. It is the same source the
 * status badge and the submissions panel already read; the timeline was the
 * one place still working from the stale copy alone.
 */
export function buildTimeline(
  d: AppDetail,
  submissionsBy?: string | null,
  liveStatus?: string | null,
  conditions?: { further_info?: boolean; decision_date?: string | null } | null
): TimelineStep[] {
  const decided = Boolean(d.decision_date);
  const ended = decided ? null : ENDED_WITHOUT_DECISION[liveStatus ?? d.status] ?? null;
  const submissions = submissionsDeadline(d, submissionsBy)?.date ?? null;
  const steps: TimelineStep[] = [
    { label: "Received", date: d.received_date, state: d.received_date ? "done" : "future" },
  ];
  const fiRequested =
    d.further_info_requested_date ??
    (conditions?.further_info ? conditions.decision_date ?? null : null);
  if (fiRequested) {
    steps.push({
      label: "Further information requested",
      date: fiRequested,
      state: d.further_info_received_date || decided ? "done" : "current",
    });
    if (d.further_info_received_date) {
      steps.push({ label: "Further information received", date: d.further_info_received_date, state: "done" });
    }
  }
  // The window for public submissions/observations closes before the decision —
  // and with the file, if it was withdrawn before the window ran out.
  if (submissions) {
    steps.push({
      label: "Submissions by",
      date: submissions,
      state: decided || ended || isPast(submissions) ? "done" : "current",
      statutory: true,
    });
  }
  if (ended) {
    // No date: the registers record that an application was withdrawn without
    // recording when, and inventing one here would be the same class of error
    // as the stale "Decision due" this replaces.
    steps.push({ label: ended, date: null, state: "done" });
  } else {
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
  }
  // An Bord Pleanála appeal: lodged, then (once decided) the operative
  // outcome — it supersedes the council's decision above.
  if (d.appeal_lodged_date || d.appeal_reference || d.appeal_decision || d.appeal_status) {
    steps.push({
      label: d.appeal_reference ? `Appeal lodged — ${d.appeal_reference}` : "Appeal lodged",
      date: d.appeal_lodged_date,
      state: d.appeal_decision ? "done" : "current",
    });
    if (d.appeal_decision) {
      // The register's own word where it names an outcome; otherwise just that
      // it was decided. "Appeal decided — MODIFIED" reads as an outcome and is
      // not one — on this file it sat under "Decided — REFUSED" while the
      // Commission had in fact granted permission.
      const label = appealOutcome(d.appeal_decision).label;
      steps.push({
        label: label ? `Appeal decided — ${label}` : "Appeal decided",
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
  // Steps are built in a fixed logical order, but dates from different sources
  // (national feed vs conditions endpoint) can arrive out of sequence. Sort
  // dated steps chronologically while keeping undated ones at the end.
  const dated = steps.filter((s) => s.date);
  const undated = steps.filter((s) => !s.date);
  dated.sort((a, b) => a.date!.localeCompare(b.date!));
  return [...dated, ...undated];
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

const APP_TYPE_HINTS: Record<string, string> = {
  permission: "A standard application to build or change something.",
  retention: "Permission sought for something already built or in use without planning permission.",
  outline: "Approval in principle only — detailed drawings come later in a follow-up application.",
  permission_consequent: "The detailed application that follows an outline permission already granted.",
  extension_of_duration: "Extending the time limit on an existing permission that hasn't been built yet.",
  exemption_declaration: "A formal ruling (Section 5) on whether particular works need planning permission at all.",
  council_development: "Development by the council itself (roads, housing, parks), approved under Part 8.",
  strategic: "A large-scale scheme decided under a special route — SHD, LRD, or Strategic Development Zone.",
};

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
export function conditionGroups(decision: string | null | undefined, superseded = false) {
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
const AGILE_CONDITION_AUTHORITIES = new Set(["south-dublin", "dublin-city", "fingal", "dlr", "cork-city", "cork-county", "wexford"]);

const conditionAnchor = (n: number) => `condition-${n}`;

/**
 * What the heading counts: conditions, not rows.
 *
 * DLR files an entire decision as one item — all six of D20A/0569's conditions
 * are inside it — so counting rows said "Conditions of this decision 1" on a
 * permission carrying six. Where a row is a schedule, its own numbering is
 * what counts; where the number cannot be read out of it, the row counts as
 * one, which is the old behaviour and never overstates.
 */
function groupCount(items: ConditionItem[]): number {
  return items.reduce((n, i) => n + (scheduleConditionCount(i.text) ?? 1), 0);
}

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

/**
 * Which prescription codes belong to which section of the sheet.
 *
 * The conditions endpoint returns one flat list for the whole application, and
 * both sections were handed all of it. Dublin City PWSDZ3074/23 is a grant
 * with sixteen conditions and no further-information items at all — its
 * "Further information" section exists only because the register carries a
 * requested date — so all sixteen binding conditions rendered underneath it,
 * headed "Conditions of this decision". Anything in the payload that is not
 * about the request now stays out of that section, and the request items stay
 * out of the decision.
 */
export const FURTHER_INFO_CODES = ["D"] as const;
/**
 * Everything the decision itself carries. "N" sits here rather than with the
 * request: Dublin City files the two halves of a split *decision* as an
 * Informative and a Note, which is why splitHalf reads them.
 */
export const DECISION_CODES = ["R", "C", "I", "N"] as const;

/**
 * Which section owns the "Informative" items — the one code the councils do
 * not agree on.
 *
 * Dublin City uses "I" for the two halves of a split decision. DLR uses it for
 * the further-information request itself: D20A/0569 carries a single
 * Informative whose text is three numbered asks — "The applicant is requested,
 * therefore, to submit revised proposals which address these concerns" — and
 * no Directive at all. Filed under the decision, that request appeared a
 * second time as "Clarifications & informatives", saying the same thing as the
 * Further information section directly above it.
 *
 * So it is routed by what the application is, not by the code: a split
 * decision keeps its halves (that is what they are), and otherwise an
 * application that went out for further information owns its Informatives.
 */
export function sectionCodes(
  decision: string | null | undefined,
  hasFurtherInfo: boolean
): { furtherInfo: readonly string[]; decision: readonly string[] } {
  const requestOwnsInformatives = hasFurtherInfo && !isSplitDecision(decision);
  return requestOwnsInformatives
    ? { furtherInfo: ["D", "I"], decision: ["R", "C", "N"] }
    : { furtherInfo: FURTHER_INFO_CODES, decision: DECISION_CODES };
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
  titles = null,
  only,
  mergeAs,
  highlights = null,
}: {
  conditions: DecisionConditions;
  decision: string | null;
  superseded?: boolean;
  /** Written labels, by condition number, for the ones their council left
   *  untitled. Null until they arrive, and often for good — South Dublin
   *  writes its own and never needs any. */
  titles?: Map<number, string> | null;
  /** The codes this section owns. Required, because the payload covers the
   *  whole application and every caller renders one part of it. */
  only: readonly string[];
  /** Render everything this section owns as one group under this heading.
   *  The request is one thing to a reader, however many codes the council
   *  split it across — DLR files it as a single Informative, Dublin City as
   *  Directives plus the reasoning behind them. */
  mergeAs?: { label: string; blurb: string | null };
  /** The notable-conditions box, rendered under the "Conditions of this
   *  decision" heading it summarises rather than above the whole stack. */
  highlights?: ReactNode;
}) {
  const split = isSplitDecision(decision);
  const mine = conditions.items.filter((i) => only.includes(i.code));
  const groups = mergeAs
    ? [{ code: "_merged", ...mergeAs, items: mine }].filter((g) => g.items.length > 0)
    : conditionGroups(decision, superseded)
        .filter((g) => only.includes(g.code))
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
            {g.label} <span className="count">{groupCount(g.items)}</span>
          </h4>
          {/* These headings are planning jargon, and "Notes" in particular
              reads as though the council imposed something. Say what the
              group actually is before the reader opens any of it. */}
          {g.blurb && <p className="condition-blurb">{g.blurb}</p>}
          {/* Under the heading it belongs to. It used to sit above the whole
              stack, where it read as a summary of the decision rather than of
              this list — and on a decision that also carries reasons and
              notes it was separated from the conditions it links into. */}
          {g.code === "C" && highlights}
          {g.items.map((item, i) => {
            const num = item.order || i + 1;
            // Portals often give a prescription no title of its own — every
            // reason on an appealed Dublin City case arrives as "ACP Reason",
            // so the list read "ACP Reason 1…4" and had to be opened to learn
            // anything. Derive a label from the wording in that case.
            // The written label wins where there is one: it says what the
            // condition controls, which is the job. Everything else is the
            // deterministic fallback — the council's own title where it wrote
            // a real one, then a theme, then the opening words.
            const title = titles?.get(num) ?? itemLabel(item, num);
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

/**
 * An AI summary that runs to more than a few sentences.
 *
 * An appeal summary is a narrative — who appealed, what was at stake, what the
 * Commission made of it — and the model breaks it where the story turns. HTML
 * collapses those breaks, so the whole thing arrived as one dense block that
 * people gave up on halfway. The paragraphs were always in the text; only the
 * rendering threw them away.
 */
function AiParagraphs({ text, className }: { text: string; className: string }) {
  const paragraphs = text
    .split(/\n{2,}/)
    .map((t) => t.trim())
    .filter(Boolean);
  return (
    <div className={className}>
      {paragraphs.map((para, i) => (
        <p key={i}>
          {/* The mark belongs to the summary, not to each paragraph of it. */}
          {i === 0 && <span className="ai-mark">✦</span>}
          {i === 0 ? " " : ""}
          {para}
        </p>
      ))}
    </div>
  );
}

/**
 * The two flags on a Commission case page worth repeating.
 *
 * EIAR and NIS are "No" on an ordinary house or mast and say nothing; on a
 * 249-unit scheme they are "Yes", and that is a real fact about the
 * development — it was large enough, or close enough to a protected site, to
 * need a formal environmental assessment before it could be decided. Spelt
 * out, because the acronyms are meaningless outside the profession.
 */
function EnvironmentalAssessment({ fields }: { fields: Array<{ label: string; value: string }> }) {
  const yes = (label: string) =>
    fields.some(
      (f) => f.label.trim().toLowerCase() === label && /^\s*yes\b/i.test(f.value ?? "")
    );
  const eiar = yes("eiar");
  const nis = yes("nis");
  if (!eiar && !nis) return null;
  return (
    <p className="section-note">
      {eiar && nis
        ? "Assessed for environmental impact and for its effect on European conservation sites."
        : eiar
          ? "Large enough to need a formal environmental impact assessment."
          : "Assessed for its effect on nearby European conservation sites."}
    </p>
  );
}

type AppealConditions = {
  conditions: Array<{ number: number | null; title: string; text: string }>;
  reasons: Array<{ number: number | null; text: string }>;
};

type SummaryState =
  | { phase: "idle" }
  | { phase: "loading" }
  | ({
      phase: "loaded";
      summary: string | null;
      source: string | null;
      source_url: string | null;
    } & AppealConditions)
  | ({ phase: "empty" } & Partial<AppealConditions>)
  | { phase: "failed" };

/**
 * A council document named, and linked to.
 *
 * Every place the sheet says where a summary came from — "AI-extracted from
 * X", "couldn't read X" — used to print the title and stop, leaving the reader
 * to find X themselves in a list that runs to a hundred entries on Kildare.
 * The document proxy takes the file's position in that list, so naming it and
 * linking to it are the same thing, and the fallbacks stay honest: no index,
 * no link, same words.
 */
function DocumentRef({
  detail: d,
  document,
  href,
}: {
  detail: AppDetail;
  document: { title: string; index?: number | null } | null;
  /** For a document that is not in the council's file list at all — the
   *  Commission publishes its orders on its own site. */
  href?: string | null;
}) {
  if (!document?.title) return null;
  const to =
    href ??
    (document.index != null && document.index >= 0
      ? `/api/applications/${d.id}/files/${document.index}`
      : null);
  if (!to) return <em>{document.title}</em>;
  return (
    <a className="doc-ref" href={to} target="_blank" rel="noopener noreferrer">
      {document.title}
    </a>
  );
}

/**
 * Conditions read out of a document, in the same collapsed rows the councils
 * with a conditions API get.
 *
 * These were a bullet list with every word of every condition inline. On a
 * 206-hectare solar farm that is fifteen conditions running to several
 * screens — one of them covering a 35-year operational life, decommissioning
 * and a restoration bond — and the reader had to scroll past all of it. The
 * titles are already written and good; only the wording needs to start shut.
 *
 * `anchored` because the notable-conditions box jumps to a condition by id,
 * and an application can carry two of these lists — the council's and the
 * Commission's, both numbered from one. Only the list the highlights belong to
 * claims the ids.
 */
function ExtractedConditions({
  conditions,
  anchored = false,
}: {
  conditions: Array<{ number: number | null; title: string; text: string }>;
  anchored?: boolean;
}) {
  return (
    <>
      {conditions.map((c, i) => {
        const num = c.number ?? i + 1;
        return (
          <details
            key={`${num}-${i}`}
            className="condition"
            id={anchored ? conditionAnchor(num) : undefined}
          >
            <summary>
              <span className="condition-num">{num}</span>
              {c.title || `Condition ${num}`}
            </summary>
            {c.text && <p className="condition-text">{c.text}</p>}
          </details>
        );
      })}
    </>
  );
}

/**
 * One related application, as a card.
 *
 * It used to be a row whose only target was the reference — a blue
 * "4034/22" you had to hit exactly — with the status and dates as inert text
 * beside it, and the eplanning variant put a "↗" on it, which says "this opens
 * somewhere else" about something that opens the sheet you are already in.
 *
 * A related application is the same kind of thing as the one on screen, so it
 * gets the same anatomy as a result in the list: what it was, what happened to
 * it, when. The reference stops being the title — it is the least readable
 * thing about an application — and becomes the quiet meta line it is
 * everywhere else in the app.
 */
function RelatedCard({
  reference,
  description,
  status,
  receivedDate,
  decisionDate,
  note,
  noteTone = "action",
  onOpen,
  href,
}: {
  reference: string;
  description?: string | null;
  status?: string | null;
  receivedDate?: string | null;
  decisionDate?: string | null;
  /** Why this one is here, when we can say something better than "same address". */
  note?: ReactNode;
  /** A note that highlights (the default) against one that merely explains.
   *  Provenance notes are long and are not the point of the card, and inside a
   *  link the accent colour reads as a second link. */
  noteTone?: "action" | "quiet";
  /** Opens the application in this sheet. */
  onOpen?: () => void;
  /** Only for a related application the register knows and we do not hold — it
   *  genuinely leaves the app, and only then does it get the arrow. */
  href?: string;
}) {
  // With no description the title falls back to the reference, and printing it
  // again in the meta line just says the same thing twice.
  const title = description?.trim() || reference;
  const body = (
    <>
      <span className="related-card-top">
        <span className="related-card-title">
          {title}
        </span>
        {status && STATUS_STYLE[status] && (
          <StatusBadge status={status} label={STATUS_STYLE[status].label} />
        )}
      </span>
      <span className="related-card-meta">
        {title !== reference && <span className="ref">{reference}</span>}
        {decisionDate ? (
          <span>decided {fmtDate(decisionDate)}</span>
        ) : receivedDate ? (
          <span>received {fmtDate(receivedDate)}</span>
        ) : null}
        {href && <span className="related-card-out">opens {new URL(href).hostname} ↗</span>}
      </span>
      {note && (
        <span className={`related-card-note${noteTone === "quiet" ? " related-card-note-quiet" : ""}`}>
          {note}
        </span>
      )}
    </>
  );
  if (href) {
    return (
      <li className="related-item">
        <a className="related-card" href={href} target="_blank" rel="noopener noreferrer">
          {body}
        </a>
      </li>
    );
  }
  return (
    <li className="related-item">
      <button type="button" className="related-card" onClick={onOpen}>
        {body}
      </button>
    </li>
  );
}

/** One or two documents, named and linked, in a sentence. */
function SourceDocuments({
  detail: d,
  documents,
}: {
  detail: AppDetail;
  documents: SourceDocument[];
}) {
  if (!documents.length) return <>the decision order</>;
  return (
    <>
      {documents.map((doc, i) => (
        <Fragment key={`${doc.title}-${doc.index}`}>
          {i > 0 && (i === documents.length - 1 ? " and " : ", ")}
          <DocumentRef detail={d} document={doc} />
        </Fragment>
      ))}
    </>
  );
}

/**
 * What to say when the council's own document defeats us.
 *
 * Never "there are no conditions": we do not know that, and on a decision it
 * is the one wrong thing that costs money. Each of these says what stopped us
 * and where the answer is instead.
 */
function unreadableNote(
  reason: DocumentReason | null,
  document: ReactNode,
  council: string
): ReactNode {
  const named = document ? <> — {document}</> : null;
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
  document: ReactNode,
  council: string
): ReactNode {
  const named = document ? <> — {document}</> : null;
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
  | { phase: "empty"; reason: DocumentReason | null; documents: SourceDocument[] }
  | {
      phase: "loaded";
      summary: string | null;
      conditions: Array<{ number: number | null; title: string; text: string }>;
      reasons: Array<{ number: number | null; text: string }>;
      highlights: ConditionHighlight[] | null;
      documents: SourceDocument[];
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
      // Older cached answers carry the title alone; the server fills the index
      // back in where it can, and where it cannot the title still prints.
      const documents: SourceDocument[] =
        res.source_documents?.length
          ? res.source_documents
          : res.source_document
            ? [{ title: res.source_document, index: -1 }]
            : [];
      if (res.summary || conditions.length || reasons.length)
        setState({
          phase: "loaded",
          summary: res.summary ?? null,
          conditions,
          reasons,
          highlights: res.highlights ?? null,
          documents,
        });
      else setState({ phase: "empty", reason: res.reason ?? null, documents });
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
          {unreadableNote(
            state.reason,
            state.documents.length ? (
              <SourceDocuments detail={d} documents={state.documents} />
            ) : null,
            d.authority_short_name
          )}
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
              {/* Same heading and same blurb as the councils with a conditions
                  API — the reader should not be able to tell that these came
                  out of a scanned order rather than a portal. */}
              <h4>
                Conditions of this decision{" "}
                <span className="count">{state.conditions.length}</span>
              </h4>
              <p className="condition-blurb">
                Binding — the permission only stands if these are met.
              </p>
              {/* The same box the councils with a conditions API get, under the
                  same heading, for the same reason. */}
              <ConditionHighlights
                highlights={state.highlights}
                loading={false}
                total={state.conditions.length}
              />
              {/* Anchored, so the notable conditions above jump into the list
                  the way they do on the councils with a conditions API. They
                  never could here: this was a <ul> with no ids, so every
                  highlight on a Kildare, Meath or Wicklow decision was a
                  button that did nothing. */}
              <ExtractedConditions conditions={state.conditions} anchored />
            </div>
          )}
          {/* Which document this came from is the useful half and stays; the
              "verify before relying on it" half is said once, in the footer.
              Named and linked, so "read it yourself" is one tap rather than a
              hunt through the file list. */}
          <p className="list-note">
            AI-extracted from <SourceDocuments detail={d} documents={state.documents} />.
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
  /* What the appeal came to. Seeded from the register so the line is there
     before anything loads, and replaced by the Commission's own wording when
     the case record arrives — the register's MODIFIED resolves to nothing at
     all, which is the honest answer until the case page speaks. */
  const [outcome, setOutcome] = useState<{ label: string | null; kind: string | null }>(() => {
    const o = appealOutcome(d.appeal_decision);
    return { label: o.label, kind: o.kind };
  });
  const rootRef = useRef<HTMLDivElement>(null);
  const loadRef = useRef<() => void>(() => {});
  useEffect(() => {
    setState({ phase: "idle" });
    setSummary({ phase: "idle" });
    const o = appealOutcome(d.appeal_decision);
    setOutcome({ label: o.label, kind: o.kind });
  }, [d.id, d.appeal_decision]);

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
        // The Commission's own wording beats the register's code, and arrives
        // with the case record rather than with the model's read of it.
        if (res.decision_label) setOutcome({ label: res.decision_label, kind: res.outcome ?? null });
        if (res.fields?.length || res.documents?.length)
          setState({ phase: "loaded", fields: res.fields ?? [], documents: res.documents ?? [] });
        else setState({ phase: "empty" });
      })
      .catch(() => setState({ phase: "failed" }));
    void api
      .appealSummary(d.id)
      .then((res) => {
        const conditions = res.conditions ?? [];
        const reasons = res.reasons ?? [];
        // A summary can be dropped for contradicting the decision while the
        // conditions read off the same order stay perfectly good.
        if (res.summary || conditions.length || reasons.length)
          setSummary({
            phase: "loaded",
            summary: res.summary ?? null,
            source: res.based_on_document ?? null,
            source_url: res.based_on_document_url ?? null,
            conditions,
            reasons,
          });
        else setSummary({ phase: "empty" });
        if (res.decision_label) setOutcome({ label: res.decision_label, kind: res.outcome ?? null });
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

      {/* What it came to, stated the way the Decision section states the
          council's — "Modified on appeal" is the register's word for "something
          changed" and told the reader nothing about whether they can build. */}
      <div className="decision-lines">
        {outcome.label ? (
          <p className="decision-line">
            <span className={outcomeClass(outcome.kind === "granted" ? "granted" : outcome.label)}>
              {outcome.label}
            </span>
            {d.appeal_decision_date && (
              <span className="hint"> · {fmtDate(d.appeal_decision_date)}</span>
            )}
          </p>
        ) : d.appeal_decision_date ? (
          /* Decided, but the register's code does not say what was decided.
             The date is a fact; the outcome is on the case file. */
          <p className="decision-line">
            Decided by An Coimisiún Pleanála
            <span className="hint"> · {fmtDate(d.appeal_decision_date)}</span>
          </p>
        ) : (
          <p className="decision-line">
            <span className="hint">
              With An Coimisiún Pleanála
              {d.appeal_lodged_date ? ` · lodged ${fmtDate(d.appeal_lodged_date)}` : ""}
            </span>
          </p>
        )}
      </div>

      {(summary.phase === "idle" || summary.phase === "loading") && (
        <div className="appeal-summary-skeleton" aria-hidden="true">
          <span /><span /><span />
        </div>
      )}
      {summary.phase === "failed" && (
        <p className="list-note">Couldn't generate a summary just now — try again shortly.</p>
      )}
      {summary.phase === "empty" && (
        <p className="list-note">
          {outcome.label
            ? /* Either the case record was too thin to summarise, or a summary
                 was written and thrown away for disagreeing with the decision
                 above. Both come to the same thing for the reader, and neither
                 is "the file is empty" — the decision line is the answer, and
                 the case file has the reasoning. */
              "No plain-English summary for this one — the decision above is the Commission's own, and the case file below has its reasoning."
            : "Not enough on the case file yet to summarise."}
        </p>
      )}
      {summary.phase === "loaded" && summary.summary && (
        /* The star marks it as model-written, in the same place as every other
           AI line in the sheet. It used to say so in a footer underneath,
           which took a line to repeat what the mark says at a glance. */
        <AiParagraphs text={summary.summary} className="ai-summary" />
      )}
      {/* A grant on appeal carries a schedule, and when the appeal overturned a
          refusal that schedule is the list of changes that turned a no into a
          yes — the most useful thing on the file and, until now, invisible.
          Same shape as the conditions on a council grant. */}
      {summary.phase === "loaded" && summary.conditions.length > 0 && (
        <div className="condition-group">
          <h4>
            Conditions of the appeal decision{" "}
            <span className="count">{summary.conditions.length}</span>
          </h4>
          {/* Not anchored: the notable-conditions box belongs to the council's
              schedule above, and both lists number from one. */}
          <ExtractedConditions conditions={summary.conditions} />
        </div>
      )}
      {/* The reasons for refusal are not listed under this. A refusal's reasons
          are what the summary above has just said in English, and the council
          side of the sheet made the same call for the same reason: the summary
          is the readable version, and the order underneath is a click away.
          Conditions are different — they are instructions, not explanation. */}
      {summary.phase === "loaded" && summary.conditions.length > 0 && (
        <p className="list-note">
          AI-extracted from{" "}
          {summary.source ? (
            <DocumentRef
              detail={d}
              document={{ title: summary.source }}
              // The Commission's orders are ordinary PDFs on its own site, so
              // this is a plain URL. Where the summary was cached before the
              // URL travelled with it, the case page's own document list —
              // already loaded above — carries the same title.
              href={
                summary.source_url ??
                (state.phase === "loaded"
                  ? state.documents.find((doc) => doc.title === summary.source)?.url ?? null
                  : null)
              }
            />
          ) : (
            "the appeal order"
          )}
          .
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
          {/* The case page publishes the same six fields every time, and five
              of them are already on this screen: the description at the top of
              the sheet, the decision and its date on the line above, and the
              case type is "Planning Appeal" on nearly all of them. Only the
              environmental flags say anything the reader could not otherwise
              know, and only when they say yes. */}
          <EnvironmentalAssessment fields={state.fields} />
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
  titles,
  only,
}: {
  detail: AppDetail;
  conditions: DecisionConditions | null;
  conditionsLoading: boolean;
  askedSummary: string | null;
  askedLoading: boolean;
  askedReason: { reason: DocumentReason | null; document: SourceDocument | null } | null;
  titles: Map<number, string> | null;
  only: readonly string[];
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
  const letter = askedReason?.document ?? null;
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
      {conditions && conditions.items.some((i) => only.includes(i.code)) && (
        <ConditionGroups
          conditions={conditions}
          decision={null}
          titles={titles}
          only={only}
          // One heading, however the council split it: DLR files the whole
          // request as a single Informative, Dublin City as Directives with
          // the reasoning beside them.
          mergeAs={{ label: "What the council asked for", blurb: null }}
        />
      )}
      {/* Kildare, Wicklow and Meath publish no structured conditions — their
          request is a scanned letter, summarised above from the PDF. So, some
          of the time, does South Dublin, whose conditions endpoint says
          nothing until a decision issues. Either way the letter is named and
          linked rather than described. */}
      {askedSummary && letter && (
        <p className="list-note">
          AI-extracted from <DocumentRef detail={d} document={letter} />.
        </p>
      )}
      {!conditions && !askedLoading && !askedSummary && (
        <p className="section-note">
          {askedReason?.reason && askedReason.reason !== "not_found" ? (
            unreadableRequestNote(
              askedReason.reason,
              letter ? <DocumentRef detail={d} document={letter} /> : null,
              d.authority_short_name
            )
          ) : letter ? (
            /* "Look for it in the documents below" made the reader go hunting
               through a list that runs to a hundred entries on Kildare, for a
               file we had already identified. */
            <>
              The request itself is on the file:{" "}
              <DocumentRef detail={d} document={letter} />.
            </>
          ) : (
            /* This used to say the council "publishes the request as a letter
               rather than as structured text", which is a claim about the
               council and is false for South Dublin — its conditions endpoint
               simply answers nothing until a decision issues. What is true
               everywhere is that the letter is on the file. */
            <>The request itself is on the file — look for it in the documents below.</>
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
  titles,
  highlightsLoading,
  only,
}: {
  detail: AppDetail;
  conditions: DecisionConditions | null;
  conditionsLoading: boolean;
  conditionsFailed: boolean;
  refusalSummary: string | null;
  refusalLoading: boolean;
  highlights: ConditionHighlight[] | null;
  titles: Map<number, string> | null;
  highlightsLoading: boolean;
  only: readonly string[];
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
          {/* Only where the register's code actually names an outcome. It
              printed "Modified on appeal" otherwise, which reads as a decision
              and is not one — the Appeal section below states it properly,
              from the Commission's own wording. */}
          {appealOutcome(d.appeal_decision).label && (
            <p className="decision-line">
              <span className={outcomeClass(appealOutcome(d.appeal_decision).label ?? "")}>
                {appealOutcome(d.appeal_decision).label}
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
        <ConditionGroups
          conditions={conditions}
          decision={decision}
          superseded={superseded}
          titles={titles}
          only={only}
          highlights={
            <ConditionHighlights
              highlights={highlights}
              loading={highlightsLoading}
              // Conditions, not rows — the "other N are standard wording" line
              // is about the decision, and DLR keeps all of its in one row.
              total={groupCount(conditions.items.filter((i) => i.code === "C"))}
            />
          }
        />
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

/** The council's own page for this application, resolved server-side where the
 *  register's URL is only a search. */
const portalHref = (d: AppDetail) =>
  d.portal_resolver ? `/api/applications/${d.id}/portal` : d.portal_url;

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
  /**
   * The agile councils' `portal_url` is a keyword search, not the
   * application — planning.agileapplications.ie needs its own internal id
   * (Dublin City WEB2100/26 is application-details/175534), which only the
   * portal API can give us. The button at the top of the sheet has always
   * gone through the resolver that fetches it; this link did not, so the way
   * into the documents landed on a search page that does not find the
   * application it was built from.
   */
  const href = d.scanned_files_url ?? (d.portal_resolver ? portalHref(d) : d.portal_url);
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

function PropertyContext({
  detail: d,
  zones,
  rzlt,
  derelict,
  flood,
  eircode,
}: {
  detail: AppDetail;
  zones: Fetched<ZoningInfo[]>;
  rzlt: Fetched<RzltInfo[]>;
  derelict: Fetched<Array<{ address: string; reference: string; council_label: string; date_added: string | null }>>;
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
        <dt>RZLT</dt>
        <dd>
          {rzlt === "pending"
            ? CHECKING
            : rzlt === "none"
              ? "Not on the RZLT map"
              : rzlt.map((r) => (
                  <div key={r.parcel_id}>
                    <strong>On RZLT map</strong>
                    {r.zone_desc && ` · ${r.zone_desc}`}
                    {r.area_ha != null && <span className="hint"> · {r.area_ha} ha</span>}
                  </div>
                ))}
        </dd>
        <dt>Derelict site</dt>
        <dd>
          {derelict === "pending"
            ? CHECKING
            : derelict === "none"
              ? "Not on a published register"
              : derelict.map((ds) => (
                  <div key={ds.reference || ds.address}>
                    <strong>On Derelict Sites Register</strong>
                    {ds.reference && <span className="hint"> · {ds.reference}</span>}
                    {ds.date_added && <span className="hint"> · since {ds.date_added}</span>}
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
 * The one-line count that sits under the address, telling the reader there is
 * more history here before they scroll two screens to find it.
 *
 * It splits the list on the reading application's own received date rather
 * than just counting, because the two directions mean opposite things. An
 * prior application is the site's history — what was asked for and what the
 * council said. A *later* one is the thing the reader has probably come for
 * and cannot see: a refusal followed six months on by a resubmission, or a
 * permission already superseded by a revised scheme. Reading the older
 * application and never learning the newer one exists is the failure this
 * line is for.
 *
 * Anything we cannot date, we do not place. If any related application is
 * missing a received date — or this one is — the sentence falls back to a
 * plain count, because "3 prior applications" would be a claim about
 * chronology we cannot actually make.
 */
export function relatedNarrative(
  related: ReadonlyArray<{ received_date?: string | null }>,
  receivedDate: string | null | undefined,
  where: string
): string | null {
  const n = related.length;
  if (n === 0) return null;
  const plural = (k: number, noun: string) => `${k} ${noun}${k === 1 ? "" : "s"}`;
  const datable = receivedDate && related.every((r) => r.received_date);
  if (!datable) return `${plural(n, "other application")} ${where}`;
  const later = related.filter((r) => (r.received_date as string) > receivedDate).length;
  const earlier = n - later;
  if (later === 0) return `${plural(earlier, "prior application")} ${where}`;
  if (earlier === 0) return `${plural(later, "more recent application")} ${where}`;
  return `${later} more recent and ${plural(earlier, "prior application")} ${where}`;
}

/**
 * The applications and appeals this one names in its own description.
 *
 * Its own section rather than folded into "at this address", because the
 * provenance is different and stronger: the council wrote this link into the
 * text itself, where the address list is our inference from a string. It sits
 * above the address list for the same reason.
 *
 * The ones we do not hold still appear. 8-16 Annamoe Road names a 2015
 * permission and its 2020 extension of duration, and we hold neither — the
 * first predates our Dublin City records, the second is a type Dublin City
 * never publishes nationally. Naming them and pointing at the council's own
 * register is worth far more than silently dropping them, which is what sent
 * someone to look it up by hand.
 */
function CitedApplications({
  cited,
  authorityName,
  onSelectRelated,
}: {
  cited: NonNullable<AppDetail["cited"]>;
  authorityName: string;
  onSelectRelated: (id: number) => void;
}) {
  if (!cited || cited.length === 0) return null;
  return (
    <section aria-labelledby="cited-h">
      <h3 id="cited-h">Named in this application</h3>
      <ul className="related-list">
        {cited.map((c) => {
          if (c.id != null) {
            return (
              <RelatedCard
                key={c.reference}
                reference={c.planning_reference ?? c.reference}
                description={c.description ?? null}
                status={c.status ?? null}
                receivedDate={c.received_date ?? null}
                decisionDate={c.decision_date ?? null}
                note={
                  c.kind === "appeal"
                    ? "The appeal named in this application's description"
                    : "Named in this application's description"
                }
                noteTone="quiet"
                onOpen={() => onSelectRelated(c.id!)}
              />
            );
          }
          // We do not hold it. Say which of the two reasons applies only where
          // we know — otherwise state the fact, which is that it is not in our
          // records, and hand over to the council's.
          const note =
            c.kind === "appeal"
              ? "An Coimisiún Pleanála case named in the description — not in our records"
              : `Named in the description — not in our records of ${authorityName}'s register`;
          return c.portal_url ? (
            <RelatedCard
              key={c.reference}
              reference={c.reference}
              description={null}
              note={note}
              noteTone="quiet"
              href={c.portal_url}
            />
          ) : (
            <li key={c.reference} className="related-item">
              <span className="related-card related-card-flat">
                <span className="related-card-top">
                  <span className="related-card-title">{c.reference}</span>
                </span>
                <span className="related-card-note">{note}</span>
              </span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

type EplanningRelatedItem = {
  id: number | null;
  planning_reference: string;
  description: string | null;
  address: string | null;
  received_date: string | null;
  status: string | null;
  eplanning_url: string;
};

/**
 * Kildare's related applications, fetched on demand from the eplanning detail
 * page.
 *
 * Held here rather than inside the section that draws it because the count
 * belongs in the header too, and a fetch owned by a component two screens down
 * cannot be counted at the top. Null means "still asking" — distinct from the
 * empty array, which means the council listed none.
 */
function useEplanningRelated(id: number, enabled: boolean): EplanningRelatedItem[] | null {
  const [items, setItems] = useState<EplanningRelatedItem[] | null>(null);
  useEffect(() => {
    if (!enabled) {
      setItems(null);
      return;
    }
    let alive = true;
    setItems(null);
    api
      .related(id)
      .then((r) => alive && setItems(r.related ?? []))
      .catch(() => alive && setItems([]));
    return () => {
      alive = false;
    };
  }, [id, enabled]);
  return items;
}

/**
 * Ones already in our register open in place; the rest deep-link to eplanning.
 * Renders nothing while loading or when there are none.
 */
function EplanningRelated({
  items,
  onSelectRelated,
}: {
  items: EplanningRelatedItem[] | null;
  onSelectRelated: (id: number) => void;
}) {
  if (!items || items.length === 0) return null;
  return (
    <section aria-labelledby="related-h">
      <h3 id="related-h">Related applications</h3>
      <ul className="related-list">
        {items.map((r) => (
          <RelatedCard
            key={r.id ?? r.eplanning_url}
            reference={r.planning_reference}
            description={r.description}
            status={r.status}
            receivedDate={r.received_date}
            {...(r.id != null
              ? { onOpen: () => onSelectRelated(r.id!) }
              : { href: r.eplanning_url })}
          />
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

/**
 * Keep the visible content stable when async sections load above the viewport.
 *
 * When a section above the scroll position grows (conditions load, AI summary
 * appears, documents expand), the browser pushes everything below it down —
 * the content the user is reading jumps off screen. This measures each child's
 * top edge before and after a resize and compensates scrollTop so the visible
 * content stays put.
 */
function useScrollAnchor(ref: React.RefObject<HTMLElement | null>) {
  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    const heights = new Map<Element, number>();

    const observer = new ResizeObserver((entries) => {
      let adjust = 0;
      for (const entry of entries) {
        const child = entry.target;
        const prev = heights.get(child);
        const now = entry.borderBoxSize?.[0]?.blockSize ?? child.getBoundingClientRect().height;
        heights.set(child, now);
        if (prev === undefined) continue;
        const delta = now - prev;
        if (delta <= 0) continue;
        const childTop = child.getBoundingClientRect().top - el.getBoundingClientRect().top + el.scrollTop;
        if (childTop < el.scrollTop) {
          adjust += delta;
        }
      }
      if (adjust > 0 && el.scrollTop > 0) {
        el.scrollTop += adjust;
      }
    });

    const wire = () => {
      observer.disconnect();
      heights.clear();
      for (const child of el.children) {
        heights.set(child, child.getBoundingClientRect().height);
        observer.observe(child);
      }
    };
    wire();

    const mutation = new MutationObserver(wire);
    mutation.observe(el, { childList: true });

    return () => {
      observer.disconnect();
      mutation.disconnect();
    };
  }, [ref]);
}

export default function DetailPanel({ detail: d, meta, onClose, onSelectRelated, saved, onToggleSave, closing, skipEntrance }: Props) {
  const isMobile = useIsMobile();
  const glossary = meta?.glossary ?? {};
  const isEplanning =
    meta?.authorities.find((a) => a.id === d.authority_id)?.source_system === "eplanning";
  // Kildare's list arrives from the council rather than from address matching,
  // so it is fetched here and shared with the section that draws it below.
  const eplanningRelated = useEplanningRelated(d.id, isEplanning);
  /**
   * "3 prior applications at this address", under the address itself.
   *
   * Two different lists feed it, and they mean different things. Everywhere
   * but Kildare it is other applications on this site, matched by address and
   * now settled on the site boundary. In Kildare it is what the council itself
   * publishes as related, which need not share an address at all — so the
   * sentence says "linked to this one" rather than claiming they are here.
   */
  /**
   * Jump to the list the line is talking about. The sheet is its own scroll
   * container, so this scrolls within it rather than the page; `block: "start"`
   * puts the heading under the sticky top rather than level with it.
   */
  const scrollToRelated = useCallback(() => {
    const heading =
      sheetRef.current?.querySelector("#cited-h") ?? sheetRef.current?.querySelector("#related-h");
    if (!heading) return;
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    heading.scrollIntoView({ behavior: reduced ? "auto" : "smooth", block: "start" });
  }, []);
  const narrative = isEplanning
    ? relatedNarrative(eplanningRelated ?? [], d.received_date, "linked to this one")
    : relatedNarrative(d.related, d.received_date, "at this address");
  /**
   * Applications named in the description are counted separately from the
   * address list and stated separately, because they are a different claim.
   * The address list is our inference; this is the council's own sentence.
   */
  const citedCount = d.cited?.length ?? 0;
  const citedClause =
    citedCount === 0
      ? null
      : `${citedCount} named in the description`;
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
  /** Which letter the request was read out of, so the section can link to it
   *  whether or not the summary worked. */
  const [askedReason, setAskedReason] = useState<{
    reason: DocumentReason | null;
    document: SourceDocument | null;
  } | null>(null);
  const [highlights, setHighlights] = useState<ConditionHighlight[] | null>(null);
  /* Labels for the conditions their council left untitled — DLR sends "C1",
     Fingal sends the first seventy characters of the wording. Applied over the
     deterministic label when they arrive, so no row is ever blank waiting. */
  const [titles, setTitles] = useState<Map<number, string> | null>(null);
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
    cited_urls?: Record<string, string>;
  } | null>(null);
  const [enrichLoading, setEnrichLoading] = useState(false);
  const [descExpanded, setDescExpanded] = useState(false);
  const [zones, setZones] = useState<Fetched<ZoningInfo[]>>("pending");
  const [rzlt, setRzlt] = useState<Fetched<RzltInfo[]>>("pending");
  const [derelict, setDerelict] = useState<Fetched<Array<{ address: string; reference: string; council_label: string; date_added: string | null }>>>("pending");
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
  // Published where the council publishes one, derived from the statutory five
  // weeks where it does not — see submissionsDeadline.
  const submissions = submissionsDeadline(d, enrich?.submissions_by_date);
  const submissionsBy = submissions?.date ?? null;
  const timeline = buildTimeline(d, enrich?.submissions_by_date, liveStatus, conditions);
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
  const askedForMore =
    d.status === "further_info" || Boolean(d.further_info_requested_date);
  // Who owns the "Informative" items — see sectionCodes.
  const codes = sectionCodes(conditions?.decision ?? d.decision, hasFurtherInfo);
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
    setTitles(null);
    setHighlightsLoading(false);
    setEnrich(null);
    setDescExpanded(false);
    let cancelled = false;
    if (d.lat != null && d.lng != null) {
      setZones("pending");
      setRzlt("pending");
      setDerelict("pending");
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
        .rzlt(d.id)
        .then((res) => {
          if (!cancelled) setRzlt(res.rzlt?.length ? res.rzlt : "none");
        })
        .catch(() => {
          if (!cancelled) setRzlt("none");
        });
      fetch("/derelict.geojson")
        .then((r) => r.ok ? r.json() as Promise<GeoJSON.FeatureCollection> : null)
        .then((fc) => {
          if (cancelled || !fc || d.lat == null || d.lng == null) {
            if (!cancelled) setDerelict("none");
            return;
          }
          const toRad = (deg: number) => (deg * Math.PI) / 180;
          const haversine = (lat1: number, lng1: number, lat2: number, lng2: number) => {
            const dLat = toRad(lat2 - lat1), dLng = toRad(lng2 - lng1);
            const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
            return 6371000 * 2 * Math.asin(Math.sqrt(a));
          };
          const featureCenter = (f: GeoJSON.Feature): [number, number] | null => {
            const g = f.geometry;
            if (g.type === "Point") return g.coordinates as [number, number];
            if (g.type === "Polygon") {
              const ring = g.coordinates[0];
              if (!ring?.length) return null;
              let sx = 0, sy = 0;
              for (const [x, y] of ring) { sx += x; sy += y; }
              return [sx / ring.length, sy / ring.length];
            }
            return null;
          };
          const nearby = fc.features
            .map((f) => {
              const c = featureCenter(f);
              if (!c) return null;
              const dist = haversine(d.lat!, d.lng!, c[1], c[0]);
              if (dist > 50) return null;
              const p = f.properties as Record<string, unknown>;
              return {
                address: String(p.address ?? "").trim(),
                reference: String(p.reference ?? "").trim(),
                council_label: String(p.council_label ?? "").trim(),
                date_added: p.date_added ? String(p.date_added) : null,
              };
            })
            .filter(Boolean) as Array<{ address: string; reference: string; council_label: string; date_added: string | null }>;
          setDerelict(nearby.length > 0 ? nearby : "none");
        })
        .catch(() => {
          if (!cancelled) setDerelict("none");
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
      setRzlt("none");
      setDerelict("none");
      setFlood("none");
    }
    // AI summary + party backfill need upstream calls, so the detail
    // endpoint returns without them and they stream in here.
    let enrichDone: Promise<unknown> = Promise.resolve();
    const hasUnresolvedCitations = d.cited?.some((c) => c.id === null && c.portal_url);
    if (!d.ai_summary || !d.applicant_name || !d.agent_name || hasUnresolvedCitations) {
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
    /**
     * The register says an application went out for further information, so
     * ask — whoever the council is.
     *
     * This used to be gated on the council having no conditions endpoint, on
     * the reasoning that the others would carry the request as "D" items in
     * the conditions payload. South Dublin has the endpoint and it answers
     * nothing until a decision issues, so on SD26B/0100W — asked in April,
     * answered in July, still undecided in August — the conditions arrived
     * null, the fetch below returned early on an empty payload, and this one
     * never ran because the council was in the wrong set. The request was read
     * by neither path. The server decides where to read it from; the sheet's
     * job is only to ask.
     */
    if (askedForMore) {
      setAskedLoading(true);
      api
        .furtherInfoSummary(d.id)
        .then((r) => {
          if (cancelled) return;
          setAskedSummary(r.summary ?? null);
          // Recorded even when the summary worked: the section names the
          // letter it was read from, and that name is a link.
          setAskedReason({
            reason: r.summary ? null : r.reason ?? null,
            document: r.source_document
              ? { title: r.source_document, index: r.source_document_index ?? -1 }
              : null,
          });
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
            // Only when the register gave no date to go on — otherwise the
            // fetch above has already asked for exactly this.
            if (
              !askedForMore &&
              (res.conditions.further_info ||
                res.conditions.items.some((i) => i.code === "D" || i.code === "I"))
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
              // Its own request: a failure here must leave the conditions and
              // the highlights exactly as they were.
              api
                .conditionTitles(d.id)
                .then((r) => {
                  if (cancelled || !r.titles?.length) return;
                  setTitles(new Map(r.titles.map((t) => [t.n, t.title])));
                })
                .catch(() => {});
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
  }, [
    d.id,
    d.ai_summary,
    d.applicant_name,
    d.agent_name,
    d.decision,
    hasConditionsSource,
    askedForMore,
  ]);

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
  useScrollAnchor(sheetRef);
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
      className={`detail-sheet ${isMobile ? "sheet-mobile" : ""}${closing ? " sheet-closing" : ""}${skipEntrance ? " sheet-no-anim" : ""}`}
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
            <span className="pill pill-type" title={APP_TYPE_HINTS[d.application_type] ?? "Application type"}>
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
        {(narrative || citedClause) && (
          <button type="button" className="related-lead" onClick={scrollToRelated}>
            <HistoryIcon size={12} />
            <span>{[narrative, citedClause].filter(Boolean).join(" · ")}</span>
            <span className="related-lead-go" aria-hidden="true">See them</span>
          </button>
        )}
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
              href={portalHref(d) ?? undefined}
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
        {stillLive && submissions && !isPast(submissions.date) && (
          <p className="submissions-open">
            <strong>Open for submissions until {fmtDate(submissions.date)}</strong>
            {(() => {
              const left = daysUntil(submissions.date);
              return left === 0 ? " — today is the last day" : ` — ${left} day${left === 1 ? "" : "s"} left`;
            })()}
            . Observations are made to {d.authority_name}, usually with a fee.
            {/* Whose date this is. The councils that publish one are stating a
                fact; everywhere else this is the statutory default applied to
                the received date, which is right in the ordinary case and can
                be moved by things the register does not record. */}
            {submissions.source === "statutory" && (
              <span className="hint">
                {" "}
                Five weeks from the date {d.authority_short_name} received it —{" "}
                {d.authority_short_name} does not publish the deadline itself, so confirm it on
                the portal before relying on it.
              </span>
            )}
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
          titles={titles}
          only={codes.furtherInfo}
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
        titles={titles}
        highlightsLoading={highlightsLoading}
        only={codes.decision}
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
                  <a
                    href={doc.source_url ?? portalHref(d) ?? "#"}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
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
        rzlt={rzlt}
        derelict={derelict}
        flood={flood}
        eircode={d.eircode ?? enrich?.eircode ?? null}
      />

      <CitedApplications
        cited={(d.cited ?? []).map((c) => {
          const resolved = enrich?.cited_urls?.[c.reference];
          return resolved ? { ...c, portal_url: resolved } : c;
        })}
        authorityName={d.authority_name}
        onSelectRelated={onSelectRelated}
      />

      {isEplanning ? (
        // Kildare (eplanning): its own "Related Applications", since townland
        // addresses make same-address matching meaningless.
        <EplanningRelated items={eplanningRelated} onSelectRelated={onSelectRelated} />
      ) : (
        <section aria-labelledby="related-h">
          <h3 id="related-h">Other applications at this address</h3>
          {d.related.length > 0 ? (
            <ul className="related-list">
              {d.related.map((r) => (
                <RelatedCard
                  key={r.id}
                  reference={r.planning_reference}
                  description={r.description}
                  status={r.status}
                  receivedDate={r.received_date}
                  decisionDate={r.decision_date}
                  onOpen={() => onSelectRelated(r.id)}
                />
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
