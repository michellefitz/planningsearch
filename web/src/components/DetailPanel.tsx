import { Fragment, useCallback, useEffect, useRef, useState } from "react";
import { api, type AppDetail, type DecisionConditions, type Meta, type ZoningInfo } from "../api";
import { SecondaryPills, StatusBadge } from "./ResultsList";
import { STATUS_STYLE } from "./MapView";
import SaveStar from "./SaveStar";

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

/** Google Maps satellite view centred on the property, via the documented Maps
 *  URLs API (basemap=satellite) — the legacy `?q=…&t=k` hack no longer switches
 *  to aerial, so it opened a plain map instead. This opens *consumer* Google
 *  Maps (google.com/maps), which is unaffected by the EEA Platform terms. */
const aerialUrl = (lat: number, lng: number): string =>
  `https://www.google.com/maps/@?api=1&map_action=map&center=${lat},${lng}&zoom=19&basemap=satellite`;

const MAPBOX_TOKEN = import.meta.env.VITE_MAPBOX_TOKEN as string | undefined;

/**
 * Static aerial thumbnail for the inline preview.
 *
 * Google's Maps Static API can't be used here: as of the EEA Platform terms
 * (8 Jul 2025), Satellite/Hybrid map types are no longer served to projects on
 * an EEA billing account, and Google Maps Content may not be shown "with or near
 * a non-Google map" — and our base map is OpenStreetMap/MapLibre. So the inline
 * thumbnail comes from a non-Google source.
 *
 * Preferred: Mapbox Satellite (freshest imagery) when VITE_MAPBOX_TOKEN is set.
 * Fallback: Esri World Imagery (keyless, same ArcGIS family as our zoning/flood
 * layers), a ~230m-wide 16:9 Web-Mercator export around the point.
 */
const esriAerial = (lat: number, lng: number): string => {
  const R = 20037508.342789244;
  const x = (lng * R) / 180;
  const y = (R * Math.log(Math.tan(((90 + lat) * Math.PI) / 360))) / Math.PI;
  const halfW = 190;
  const halfH = (halfW * 360) / 640;
  const bbox = `${x - halfW},${y - halfH},${x + halfW},${y + halfH}`;
  return (
    "https://server.arcgisonline.com/arcgis/rest/services/World_Imagery/MapServer/export" +
    `?bbox=${bbox}&bboxSR=3857&imageSR=3857&size=640,360&format=jpg&f=image`
  );
};

const mapboxAerial = (lat: number, lng: number): string =>
  `https://api.mapbox.com/styles/v1/mapbox/satellite-v9/static/` +
  `${lng},${lat},17.5,0/640x360@2x` +
  `?access_token=${MAPBOX_TOKEN}`;

/** Non-Google satellite thumbnail: Mapbox when a token is configured, else Esri. */
const aerialThumb = (lat: number, lng: number): string =>
  MAPBOX_TOKEN ? mapboxAerial(lat, lng) : esriAerial(lat, lng);

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
          <a
            className="btn"
            href={aerialUrl(d.lat!, d.lng!)}
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

/** Compass bearing (deg, 0–360) from one lat/lng to another — used to aim the
 *  Street View camera from the chosen panorama toward the property, so it faces
 *  the building instead of pointing along the road. */
function bearing(fromLat: number, fromLng: number, toLat: number, toLng: number): number {
  const toRad = (x: number) => (x * Math.PI) / 180;
  const φ1 = toRad(fromLat);
  const φ2 = toRad(toLat);
  const Δλ = toRad(toLng - fromLng);
  const y = Math.sin(Δλ) * Math.cos(φ2);
  const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
  return (Math.atan2(y, x) * 180) / Math.PI; // Google accepts negative headings
}

function PropertyMedia({ detail: d }: { detail: AppDetail }) {
  // null = no panorama / not loaded; object = the panorama, with the heading
  // that aims it from the pano back at the property.
  const [pano, setPano] = useState<{
    panoId: string;
    date: string | null;
    heading: number | null;
  } | null>(null);
  const hasCoords = d.lat != null && d.lng != null;

  useEffect(() => {
    setPano(null);
    if (!GMAPS_KEY || !hasCoords) return;
    const ctrl = new AbortController();
    const lat = d.lat!;
    const lng = d.lng!;

    // Simply the nearest outdoor panorama. We tried searching a ring around the
    // site for more recent imagery, but "newest" is no proxy for "the road the
    // property is on" — it could land a street away. Nearest is at least
    // predictable, and the click-through lets people walk to the frontage.
    fetch(
      `https://maps.googleapis.com/maps/api/streetview/metadata?location=${lat},${lng}&source=outdoor&key=${GMAPS_KEY}`,
      { signal: ctrl.signal }
    )
      .then((r) => r.json())
      .then((m: { status: string; date?: string; pano_id?: string; location?: { lat: number; lng: number } }) => {
        if (m.status !== "OK" || !m.pano_id) return setPano(null);
        setPano({
          panoId: m.pano_id,
          date: m.date ?? null,
          heading: m.location
            ? Math.round(bearing(m.location.lat, m.location.lng, lat, lng))
            : null,
        });
      })
      .catch(() => setPano(null));
    return () => ctrl.abort();
  }, [d.id, d.lat, d.lng, hasCoords]);

  // If a static image fails (e.g. the Maps Static API isn't enabled on the key),
  // hide the broken image and leave the tile as a labelled link to the map.
  const onImgError = (e: { currentTarget: HTMLImageElement }) => {
    e.currentTarget.style.display = "none";
    e.currentTarget.parentElement?.classList.add("media-tile-failed");
  };

  if (!GMAPS_KEY || !hasCoords) return null;
  return (
    <div className="media-row">
      {pano && (
        <a
          // Open the same panorama we picked, aimed the same way, so the
          // click-through matches the thumbnail.
          href={
            `https://www.google.com/maps/@?api=1&map_action=pano&pano=${pano.panoId}` +
            (pano.heading != null ? `&heading=${pano.heading}` : "")
          }
          target="_blank"
          rel="noopener noreferrer"
          className="media-tile"
        >
          <img
            src={
              // Render the panorama we chose by id (not location, which would
              // re-pick the nearest one). fov=110 (default 90): our coordinate is
              // the site centroid, not the building frontage, so a narrow cone can
              // leave the house at the edge of frame.
              `https://maps.googleapis.com/maps/api/streetview?size=640x360&pano=${pano.panoId}&fov=110` +
              (pano.heading != null ? `&heading=${pano.heading}` : "") +
              `&key=${GMAPS_KEY}`
            }
            alt={`Street View of ${d.address_text ?? "the property"}`}
            loading="lazy"
            onError={onImgError}
          />
          <span className="media-label">
            Street View{pano.date ? ` · ${formatPanoDate(pano.date)}` : ""}
          </span>
        </a>
      )}
      <a href={aerialUrl(d.lat!, d.lng!)} target="_blank" rel="noopener noreferrer" className="media-tile">
        <img
          src={aerialThumb(d.lat!, d.lng!)}
          alt={`Aerial view of ${d.address_text ?? "the property"}`}
          loading="lazy"
          onError={onImgError}
        />
        {/* The image is centred on the property, so the tile centre marks it. */}
        <span className="aerial-pin" aria-hidden="true">
          <svg viewBox="0 0 24 24" width="30" height="30">
            <path
              d="M12 2C8.1 2 5 5.1 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.9-3.1-7-7-7z"
              fill="#e11d48"
              stroke="#fff"
              strokeWidth="1.6"
            />
            <circle cx="12" cy="9" r="2.6" fill="#fff" />
          </svg>
        </span>
        <span className="media-label">Aerial ↗</span>
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
        {/* While the window is open, make the submissions deadline actionable —
            this is the one date a member of the public can still act on. */}
        {!d.decision_date && d.submissions_by_date && !isPast(d.submissions_by_date) && (
          <p className="submissions-open">
            <strong>Open for submissions until {d.submissions_by_date}</strong>
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
