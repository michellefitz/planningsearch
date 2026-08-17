import { useEffect, useState } from "react";
import { DEFAULT_STATUSES, HIDDEN_BY_DEFAULT_STATUSES, fmtDate, MIN_UNITS_OPTIONS, type Meta, type SearchState } from "../api";
import { STATUS_STYLE } from "./MapView";
import DateRangePicker from "./DateRangePicker";
import MultiSelect from "./MultiSelect";
import { XIcon } from "./icons";

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
    out.push({ key: "dates", label, remove: () => onChange({ ...s, receivedFrom: "", receivedTo: "" }) });
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
  minUnits: 0,
  useMapArea: false,
};

export default function FiltersBar({ meta, state, onChange, total }: Props) {
  const applied = appliedFilters(meta, state, onChange);
  const activeCount = applied.length;
  const [open, setOpen] = useState(false);

  const statusSelection = statusesCustomised(state) ? state.statuses : [];
  const handleStatusChange = (selected: string[]) =>
    onChange({ ...state, statuses: selected.length === 0 ? [...DEFAULT_STATUSES] : selected });

  // On mobile the panel is a full-screen sheet, so the page behind it must not
  // scroll under the finger.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
    };
  }, [open]);

  return (
    <div className={`filters-wrap${open ? " filters-open" : ""}`}>
      <button
        type="button"
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

      {/* Applied chips sit BELOW the button: above it, adding or clearing one
          re-flowed the row and moved the button out from under the thumb. */}
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

      {open && <div className="filters-scrim" onClick={() => setOpen(false)} aria-hidden="true" />}

      <div className="filters-panel" role="dialog" aria-modal="true" aria-label="Filters" hidden={!open}>
        <div className="sheet-head">
          <button type="button" className="sheet-close" onClick={() => setOpen(false)} aria-label="Close filters">
            <XIcon size={13} />
          </button>
          <h2>Filters</h2>
          <button
            type="button"
            className="sheet-reset"
            onClick={() => onChange({ ...state, ...CLEARED })}
            disabled={activeCount === 0}
          >
            Reset
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
          <button type="button" className="btn btn-primary sheet-submit" onClick={() => setOpen(false)}>
            Show {total.toLocaleString()} result{total === 1 ? "" : "s"}
          </button>
        </div>
      </div>
    </div>
  );
}

function statusesCustomised(s: SearchState): boolean {
  if (s.statuses.length !== DEFAULT_STATUSES.length) return true;
  const set = new Set(s.statuses);
  return DEFAULT_STATUSES.some((k) => !set.has(k));
}
