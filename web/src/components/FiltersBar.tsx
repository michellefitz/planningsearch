import { useEffect, useRef, useState } from "react";
import { DEFAULT_STATUSES, HIDDEN_BY_DEFAULT_STATUSES, fmtDate, MIN_UNITS_OPTIONS, type Meta, type SearchState } from "../api";
import { STATUS_STYLE } from "../statusStyle";
import DateRangePicker from "./DateRangePicker";
import MultiSelect from "./MultiSelect";

interface Props {
  meta: Meta | null;
  state: SearchState;
  onChange: (next: SearchState) => void;
  /** Matching applications, named on the sheet's submit button. */
  total: number;
}

interface Applied {
  key: string;
  label: string;
  remove: () => void;
}

function appliedFilters(meta: Meta | null, s: SearchState, onChange: (n: SearchState) => void): Applied[] {
  const out: Applied[] = [];
  for (const id of s.authorities) {
    const label = meta?.authorities.find((a) => a.id === id)?.short_name ?? id;
    out.push({ key: `auth-${id}`, label, remove: () => onChange({ ...s, authorities: s.authorities.filter((v) => v !== id) }) });
  }
  if (statusesCustomised(s)) {
    for (const k of s.statuses) {
      const label = STATUS_STYLE[k]?.label ?? k;
      out.push({ key: `status-${k}`, label, remove: () => {
        const next = s.statuses.filter((v) => v !== k);
        onChange({ ...s, statuses: next.length === 0 ? [...DEFAULT_STATUSES] : next });
      }});
    }
  }
  for (const t of s.types) {
    out.push({ key: `type-${t}`, label: meta?.application_types[t] ?? t, remove: () => onChange({ ...s, types: s.types.filter((v) => v !== t) }) });
  }
  if (s.receivedFrom || s.receivedTo) {
    const label =
      s.receivedFrom && s.receivedTo
        ? `${fmtDate(s.receivedFrom)} – ${fmtDate(s.receivedTo)}`
        : s.receivedFrom
          ? `From ${fmtDate(s.receivedFrom)}`
          : `Until ${fmtDate(s.receivedTo)}`;
    out.push({ key: "received-dates", label: `Received ${label}`, remove: () => onChange({ ...s, receivedFrom: "", receivedTo: "" }) });
  }
  if (s.decisionFrom || s.decisionTo) {
    const label =
      s.decisionFrom && s.decisionTo
        ? `${fmtDate(s.decisionFrom)} – ${fmtDate(s.decisionTo)}`
        : s.decisionFrom
          ? `From ${fmtDate(s.decisionFrom)}`
          : `Until ${fmtDate(s.decisionTo)}`;
    out.push({ key: "decision-dates", label: `Decided ${label}`, remove: () => onChange({ ...s, decisionFrom: "", decisionTo: "" }) });
  }
  if (s.minUnits) {
    const label = MIN_UNITS_OPTIONS.find((o) => o.value === s.minUnits)?.label ?? `${s.minUnits}+ homes`;
    out.push({ key: "minunits", label, remove: () => onChange({ ...s, minUnits: 0 }) });
  }
  if (s.domesticOnly) out.push({ key: "domestic", label: "Domestic only", remove: () => onChange({ ...s, domesticOnly: false }) });
  if (s.oneOffOnly) out.push({ key: "oneoff", label: "One-off houses", remove: () => onChange({ ...s, oneOffOnly: false }) });
  if (s.appealedOnly) out.push({ key: "appealed", label: "Appealed", remove: () => onChange({ ...s, appealedOnly: false }) });
  if (s.commencedOnly) out.push({ key: "commenced", label: "Work commenced", remove: () => onChange({ ...s, commencedOnly: false }) });
  if (s.useMapArea) out.push({ key: "maparea", label: "Current map area", remove: () => onChange({ ...s, useMapArea: false }) });
  return out;
}

const ALL_STATUS_KEYS = [...DEFAULT_STATUSES, ...HIDDEN_BY_DEFAULT_STATUSES];

const STATUS_OPTIONS = ALL_STATUS_KEYS
  .filter((k) => k !== "unknown")
  .map((k) => ({ id: k, label: STATUS_STYLE[k]?.label ?? k }));

/** Everything the filter panel controls, back to defaults. */
const CLEARED = {
  authorities: [] as string[],
  statuses: [...DEFAULT_STATUSES],
  types: [] as string[],
  domesticOnly: false,
  oneOffOnly: false,
  appealedOnly: false,
  commencedOnly: false,
  receivedFrom: "",
  receivedTo: "",
  decisionFrom: "",
  decisionTo: "",
  minUnits: 0,
  useMapArea: false,
};

export default function FiltersBar({ meta, state, onChange, total }: Props) {
  const applied = appliedFilters(meta, state, onChange);
  const activeCount = applied.length;
  const [open, setOpen] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  /** Where the desktop dropdown hangs, measured from the button. Null on
   *  mobile, where the panel is a bottom sheet and needs no anchoring. */
  const [anchor, setAnchor] = useState<{ top: number; left: number; maxHeight: number } | null>(null);

  const statusSelection = statusesCustomised(state) ? state.statuses : [];
  const handleStatusChange = (selected: string[]) =>
    onChange({ ...state, statuses: selected.length === 0 ? [...DEFAULT_STATUSES] : selected });

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    // On mobile the panel is a bottom sheet, so the page behind it must not
    // scroll under the finger. On desktop the scrim already swallows the
    // pointer, and locking the body there only risks a scrollbar reflow.
    const phone = window.matchMedia("(max-width: 767px)").matches;
    const prev = document.body.style.overflow;
    if (phone) document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      if (phone) document.body.style.overflow = prev;
    };
  }, [open]);

  /**
   * Hang the desktop panel off the button as a fixed overlay.
   *
   * It used to drop inline, which pushed the whole result list down the moment
   * it opened and hauled it back up on close — the list jumped every time
   * anyone went near a filter. Fixed positioning takes it out of flow so the
   * results stay where they are; the coordinates have to be measured because
   * the side panel scrolls, so `position: absolute` inside it would be clipped
   * by its own overflow.
   */
  useEffect(() => {
    if (!open) return;
    const place = () => {
      const b = btnRef.current;
      if (!b || !window.matchMedia("(min-width: 768px)").matches) {
        setAnchor(null);
        return;
      }
      const r = b.getBoundingClientRect();
      const top = r.bottom + 8;
      setAnchor({ top, left: r.left, maxHeight: Math.max(220, window.innerHeight - top - 24) });
    };
    place();
    window.addEventListener("resize", place);
    return () => window.removeEventListener("resize", place);
  }, [open]);

  /**
   * Drag the sheet down to dismiss, from the grab handle.
   *
   * Bound to the handle rather than the whole sheet: the body scrolls, and a
   * drag that starts anywhere would fight it. Simpler than the property
   * sheet's equivalent because this one has a single height — there is no peek
   * state to snap back to, so it is either dismissed or it isn't.
   */
  useEffect(() => {
    const panel = panelRef.current;
    const grabber = panel?.querySelector<HTMLElement>(".sheet-grabber");
    if (!open || !panel || !grabber) return;
    let startY = 0;
    let dy = 0;
    let dragging = false;

    const start = (e: TouchEvent) => {
      startY = e.touches[0].clientY;
      dy = 0;
      dragging = true;
      panel.style.transition = "none";
    };
    const move = (e: TouchEvent) => {
      if (!dragging) return;
      dy = Math.max(0, e.touches[0].clientY - startY);
      e.preventDefault();
      panel.style.transform = `translateY(${dy}px)`;
    };
    const end = () => {
      if (!dragging) return;
      dragging = false;
      panel.style.transition = "transform 220ms cubic-bezier(0.32, 0.72, 0, 1)";
      if (dy > 110) {
        panel.style.transform = "translateY(100%)";
        window.setTimeout(() => {
          setOpen(false);
          panel.style.transform = "";
          panel.style.transition = "";
        }, 200);
      } else {
        panel.style.transform = "";
      }
    };

    grabber.addEventListener("touchstart", start, { passive: true });
    grabber.addEventListener("touchmove", move, { passive: false });
    grabber.addEventListener("touchend", end);
    grabber.addEventListener("touchcancel", end);
    return () => {
      grabber.removeEventListener("touchstart", start);
      grabber.removeEventListener("touchmove", move);
      grabber.removeEventListener("touchend", end);
      grabber.removeEventListener("touchcancel", end);
      panel.style.transform = "";
      panel.style.transition = "";
    };
  }, [open]);

  return (
    <>
      <div className={`filters-wrap${open ? " filters-open" : ""}`}>
      <button
        type="button"
        ref={btnRef}
        className={`filters-btn${activeCount > 0 ? " filters-btn-on" : ""}`}
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden="true">
          <path d="M2 4.5h12M4.5 8h7M6.5 11.5h3" />
        </svg>
        Filters
        {activeCount > 0 && <span className="filters-count">{activeCount}</span>}
      </button>

      {open && <div className="filters-scrim" onClick={() => setOpen(false)} aria-hidden="true" />}

      <div
        className="filters-panel"
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label="Filters"
        hidden={!open}
        style={anchor ? { top: anchor.top, left: anchor.left, maxHeight: anchor.maxHeight } : undefined}
      >
        {/* Same grab handle as the property sheet — on a phone this is a bottom
            sheet, and the handle is what says "drag me down". Hidden on
            desktop, where the panel drops inline. */}
        <div className="sheet-grabber" aria-hidden="true">
          <span className="grabber-bar" />
        </div>
        {/* Clear left, confirm right. It was the other way round — an X on the
            left that applied, and Clear where a thumb expects "done" — so the
            habit of reaching for the top-right wiped the filters instead of
            keeping them. There is no way to open this and *not* apply, so the
            right-hand control is a tick, not a cancel. */}
        <div className="sheet-head">
          <button
            type="button"
            className="sheet-reset"
            onClick={() => onChange({ ...state, ...CLEARED })}
            disabled={activeCount === 0}
          >
            Clear
          </button>
          <h2>Filters</h2>
          <button
            type="button"
            className="sheet-confirm"
            onClick={() => setOpen(false)}
            aria-label="Done — apply filters"
          >
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M3 8.5 6.2 11.7 13 4.9" />
            </svg>
          </button>
        </div>

        <div className="sheet-body">
      <fieldset>
        <legend>Council</legend>
        <MultiSelect
          allLabel="All councils"
          ariaLabel="Filter by council"
          options={(meta?.authorities ?? []).map((a) => ({ id: a.id, label: a.short_name }))}
          selected={state.authorities}
          onChange={(authorities) => onChange({ ...state, authorities })}
        />
      </fieldset>

      <fieldset>
        <legend>Status</legend>
        <MultiSelect
          allLabel="All statuses"
          ariaLabel="Filter by status"
          options={STATUS_OPTIONS}
          selected={statusSelection}
          onChange={handleStatusChange}
        />
      </fieldset>

      <fieldset>
        <legend>Type</legend>
        <MultiSelect
          allLabel="All types"
          ariaLabel="Filter by application type"
          options={Object.entries(meta?.application_types ?? {})
            .filter(([k]) => k !== "other")
            .map(([k, label]) => ({ id: k, label }))}
          selected={state.types}
          onChange={(types) => onChange({ ...state, types })}
        />
      </fieldset>

      <fieldset>
        <legend>Received</legend>
        <DateRangePicker
          from={state.receivedFrom}
          to={state.receivedTo}
          onChange={(receivedFrom, receivedTo) => onChange({ ...state, receivedFrom, receivedTo })}
        />
      </fieldset>

      <fieldset>
        <legend>Decided</legend>
        <DateRangePicker
          from={state.decisionFrom}
          to={state.decisionTo}
          onChange={(decisionFrom, decisionTo) => onChange({ ...state, decisionFrom, decisionTo })}
        />
      </fieldset>

      {/* No "Advanced" fold: a full-screen sheet has room to show everything,
          and hiding half the filters behind a second disclosure was the same
          problem the panel itself had. */}
      <fieldset>
          <legend>Development size</legend>
          <div className="chip-row">
            {MIN_UNITS_OPTIONS.map((o) => (
              <label key={o.value} className={`chip ${state.minUnits === o.value ? "chip-on" : ""}`}>
                <input
                  type="radio"
                  name="min-units"
                  checked={state.minUnits === o.value}
                  onChange={() => onChange({ ...state, minUnits: o.value })}
                />
                {o.label}
              </label>
            ))}
          </div>
        </fieldset>

        <fieldset>
          <legend>Other</legend>
          <label className="toggle-row" title="Best-effort classification, not an official planning category">
            <input
              type="checkbox"
              checked={state.domesticOnly}
              onChange={(e) => onChange({ ...state, domesticOnly: e.target.checked })}
            />
            Domestic only
          </label>
          <label className="toggle-row" title="A new house on its own site — distinct from extensions or estates">
            <input
              type="checkbox"
              checked={state.oneOffOnly}
              onChange={(e) => onChange({ ...state, oneOffOnly: e.target.checked })}
            />
            One-off houses
          </label>
          <label className="toggle-row" title="Application has a record with An Coimisiún Pleanála">
            <input
              type="checkbox"
              checked={state.appealedOnly}
              onChange={(e) => onChange({ ...state, appealedOnly: e.target.checked })}
            />
            Appealed
          </label>
          <label className="toggle-row" title="A commencement notice was filed with building control">
            <input
              type="checkbox"
              checked={state.commencedOnly}
              onChange={(e) => onChange({ ...state, commencedOnly: e.target.checked })}
            />
            Work commenced
          </label>
          <label className="toggle-row">
            <input
              type="checkbox"
              checked={state.useMapArea}
              onChange={(e) => onChange({ ...state, useMapArea: e.target.checked })}
            />
            Limit to current map area
          </label>
        </fieldset>
        </div>

        {/* Results update as each control changes; this just gets the sheet out
            of the way. Naming the count makes that visible, so the button reads
            as "done" rather than "apply". */}
        <div className="sheet-foot">
          {/* Desktop only. The bottom sheet carries Clear in its title bar,
              where a thumb reaches; a dropdown has no title bar, so it goes
              beside the button that closes it. */}
          <button
            type="button"
            className="foot-clear"
            onClick={() => onChange({ ...state, ...CLEARED })}
            disabled={activeCount === 0}
          >
            Clear
          </button>
          <button type="button" className="btn btn-primary sheet-submit" onClick={() => setOpen(false)}>
            Show {total.toLocaleString()} result{total === 1 ? "" : "s"}
          </button>
        </div>
      </div>
      </div>

      {/* Applied chips sit BELOW the controls row: above it, adding or clearing
          one re-flowed the row and moved the button out from under the thumb.
          A sibling of the wrap rather than a child, so the row above can stay
          one line while these wrap onto their own. */}
      {applied.length > 0 && (
        <div className="applied-row" role="group" aria-label="Active filters">
          {applied.map((f) => (
            <button key={f.key} type="button" className="applied-chip" onClick={f.remove} aria-label={`Remove filter: ${f.label}`}>
              {f.label}
              <span className="applied-x" aria-hidden="true">
                <svg width="8" height="8" viewBox="0 0 8 8" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round">
                  <path d="M1 1l6 6M7 1L1 7" />
                </svg>
              </span>
            </button>
          ))}
        </div>
      )}
    </>
  );
}

function statusesCustomised(s: SearchState): boolean {
  if (s.statuses.length !== DEFAULT_STATUSES.length) return true;
  const set = new Set(s.statuses);
  return DEFAULT_STATUSES.some((k) => !set.has(k));
}
