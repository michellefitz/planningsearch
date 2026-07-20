import { Fragment, useEffect, useState } from "react";
import { api, type AppDetail, type DecisionConditions, type Meta, type ZoningInfo } from "../api";
import { StatusBadge } from "./ResultsList";

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
 * On-demand read of the council's scanned decision order — for
 * eplanning/iDocs councils that expose no structured conditions, the
 * summary, conditions of grant and any reasons for refusal live only in
 * that PDF. Reading it is slow, so it stays a click.
 */
function DecisionOrderSummary({ detail: d }: { detail: AppDetail }) {
  const [state, setState] = useState<DecisionOrderState>({ phase: "idle" });
  useEffect(() => setState({ phase: "idle" }), [d.id]);

  const load = async () => {
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
  };

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
        <p className="list-note">
          Couldn't read the decision order just now — see the documents below.
        </p>
      )}
      {state.phase === "empty" && (
        <p className="list-note">
          Couldn't find a readable decision order — see the documents below.
        </p>
      )}
      {state.phase === "loaded" && (
        <>
          {state.reasons.length > 0 ? (
            <div className="ai-summary refusal-summary">
              {state.summary && <p className="decision-lead">✦ {state.summary}</p>}
              <ul className="decision-list">
                {state.reasons.map((r, i) => (
                  <li key={i}>{r.text}</li>
                ))}
              </ul>
            </div>
          ) : (
            state.summary && <p className="ai-summary">✦ {state.summary}</p>
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
}: {
  detail: AppDetail;
  conditions: DecisionConditions | null;
  conditionsLoading: boolean;
}) {
  const decision = conditions?.decision ?? d.decision;
  const decisionDate = conditions?.decision_date ?? d.decision_date;
  const hasAppeal = Boolean(d.appeal_reference || d.appeal_decision);
  if (!decision && !hasAppeal) return null;
  // eplanning/iDocs councils record their reasons only in the scanned
  // decision order — offer the on-demand PDF summary instead of conditions.
  const scannedOrderOnly =
    Boolean(d.decision && d.scanned_files_url) && !AGILE_CONDITION_AUTHORITIES.has(d.authority_id);

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
      {conditions?.refusal_summary && (
        <p className="ai-summary refusal-summary">✦ {conditions.refusal_summary}</p>
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

/**
 * Location context — zoning, flood risk and recorded sales as one compact
 * list of data points, not full sections. Helpful colour when reading an
 * application, with one shared provenance note.
 */
function PropertyContext({
  detail: d,
  zones,
  flood,
}: {
  detail: AppDetail;
  zones: ZoningInfo[] | null;
  flood: { at_risk: boolean; scenarios: string[] } | null;
}) {
  const sales = d.ppr_sales ?? [];
  if (!zones?.length && !flood && sales.length === 0) return null;

  return (
    <section aria-labelledby="place-h">
      <h3 id="place-h">This property</h3>
      <dl className="place-list">
        {zones?.map((z) => (
          <Fragment key={z.zone}>
            <dt>Zoning</dt>
            <dd>
              <strong>{z.zone}</strong>
              {z.general && ` · ${z.general}`}
              {z.objective && ` — ${z.objective}`}
              {z.plan && (
                <span className="hint">
                  {" "}
                  ({z.plan}
                  {z.plan_level === "LAP" ? ", Local Area Plan" : ""})
                </span>
              )}
              {z.plan_url && (
                <>
                  {" "}
                  <a href={z.plan_url} target="_blank" rel="noopener noreferrer">
                    Development plan ↗
                  </a>
                </>
              )}
            </dd>
          </Fragment>
        ))}
        {flood && (
          <>
            <dt>Flood risk</dt>
            <dd>
              {flood.at_risk ? (
                <span className="flood-warn-inline">
                  Within a mapped flood extent
                  {flood.scenarios.length > 0 && ` — ${flood.scenarios.join("; ")}`}
                </span>
              ) : (
                "None mapped at this location"
              )}{" "}
              <a href="https://www.floodinfo.ie/" target="_blank" rel="noopener noreferrer">
                floodinfo.ie ↗
              </a>
            </dd>
          </>
        )}
        {sales.map((s) => (
          <Fragment key={`${s.date}-${s.price}`}>
            <dt>Sold</dt>
            <dd>
              <strong>€{s.price.toLocaleString()}</strong>
              <span className="hint"> · {s.date}</span>
              {s.description && <span className="hint"> — {s.description}</span>}
              {s.vat_exclusive && <span className="tag">price excludes VAT</span>}
              {s.not_full_market && <span className="tag">not full market price</span>}
            </dd>
          </Fragment>
        ))}
      </dl>
      <p className="list-note">
        Zoning from MyPlan (DHLGH), flood extents from indicative OPW mapping, sales matched on
        the PSRA{" "}
        <a href="https://www.propertypriceregister.ie/" target="_blank" rel="noopener noreferrer">
          Property Price Register ↗
        </a>
        {" "}— confirm at source before relying on any of them.
      </p>
    </section>
  );
}

export default function DetailPanel({ detail: d, meta, onClose, onSelectRelated }: Props) {
  const glossary = meta?.glossary ?? {};
  const timeline = buildTimeline(d);
  const stats = buildStats(d);
  const [conditions, setConditions] = useState<DecisionConditions | null>(null);
  const [conditionsLoading, setConditionsLoading] = useState(false);
  const [enrich, setEnrich] = useState<{
    ai_summary: string | null;
    applicant_name: string | null;
    agent_name: string | null;
    description?: string | null;
  } | null>(null);
  const [enrichLoading, setEnrichLoading] = useState(false);
  const [descExpanded, setDescExpanded] = useState(false);
  const [zones, setZones] = useState<ZoningInfo[] | null>(null);
  const [flood, setFlood] = useState<{ at_risk: boolean; scenarios: string[] } | null>(null);
  // Enrichment can supply a fuller proposal description than the (sometimes
  // truncated) national one — prefer it for both the display and the summary.
  const description = enrich?.description ?? d.description ?? null;
  // ~65 chars per line at the sheet's width — beyond ~6 lines, clamp.
  const isLongDesc = (description ?? "").length > 400;
  const hasConditionsSource = AGILE_CONDITION_AUTHORITIES.has(d.authority_id);

  useEffect(() => {
    setConditions(null);
    setEnrich(null);
    setDescExpanded(false);
    setZones(null);
    setFlood(null);
    let cancelled = false;
    if (d.lat != null && d.lng != null) {
      api
        .zoning(d.id)
        .then((res) => {
          if (!cancelled && res.zones?.length) setZones(res.zones);
        })
        .catch(() => {});
      api
        .flood(d.id)
        .then((res) => {
          if (!cancelled && res.flood) setFlood(res.flood);
        })
        .catch(() => {});
    }
    if (hasConditionsSource) {
      setConditionsLoading(true);
      api
        .conditions(d.id)
        .then((res) => {
          if (!cancelled && res.conditions?.items.length) setConditions(res.conditions);
        })
        .catch(() => {})
        .finally(() => {
          if (!cancelled) setConditionsLoading(false);
        });
    }
    // AI summary + party backfill need upstream calls, so the detail
    // endpoint returns without them and they stream in here.
    if (!d.ai_summary || !d.applicant_name || !d.agent_name) {
      setEnrichLoading(true);
      api
        .enrich(d.id)
        .then((res) => {
          if (!cancelled) setEnrich(res);
        })
        .catch(() => {})
        .finally(() => {
          if (!cancelled) setEnrichLoading(false);
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

  return (
    <aside className="detail-sheet" aria-label={`Application ${d.planning_reference}`} role="dialog">
      <div className="sheet-top">
        <StatusBadge status={d.status} label={statusDisplayLabel(d)} />
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

      <DecisionSection detail={d} conditions={conditions} conditionsLoading={conditionsLoading} />

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

      <PropertyContext detail={d} zones={zones} flood={flood} />

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
          register data — the {d.authority_name} register (and An Coimisiún Pleanála for appeals)
          is the authoritative source.
        </p>
      </footer>
    </aside>
  );
}
