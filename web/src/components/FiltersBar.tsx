import { DEFAULT_STATUSES, HIDDEN_BY_DEFAULT_STATUSES, fmtDate, MIN_UNITS_OPTIONS, type Meta, type SearchState } from "../api";
import { STATUS_STYLE } from "./MapView";
import MultiSelect from "./MultiSelect";

interface Props {
  meta: Meta | null;
  state: SearchState;
  onChange: (next: SearchState) => void;
}

function toggle(list: string[], value: string): string[] {
  return list.includes(value) ? list.filter((v) => v !== value) : [...list, value];
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
    const label =
      s.statuses.length <= 3
        ? s.statuses.map((k) => STATUS_STYLE[k]?.label ?? k).join(", ")
        : `Status · ${s.statuses.length} selected`;
    out.push({ key: "statuses", label, remove: () => onChange({ ...s, statuses: [...DEFAULT_STATUSES] }) });
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

export default function FiltersBar({ meta, state, onChange }: Props) {
  const applied = appliedFilters(meta, state, onChange);
  const activeCount = applied.length;

  const statusSelection = statusesCustomised(state) ? state.statuses : [];
  const handleStatusChange = (selected: string[]) =>
    onChange({ ...state, statuses: selected.length === 0 ? [...DEFAULT_STATUSES] : selected });

  return (
    <>
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
        {applied.length > 1 && (
          <button
            type="button"
            className="applied-clear"
            onClick={() =>
              onChange({
                ...state,
                authorities: [],
                statuses: [...DEFAULT_STATUSES],
                types: [],
                domesticOnly: false,
                oneOffOnly: false,
                appealedOnly: false,
                commencedOnly: false,
                receivedFrom: "",
                receivedTo: "",
                minUnits: 0,
                useMapArea: false,
              })
            }
          >
            Clear all
          </button>
        )}
      </div>
    )}
    <details className="filters" open={false}>
      <summary>Filters{activeCount > 0 && ` (${activeCount})`}</summary>

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
        <div className="chip-row">
          {Object.entries(meta?.application_types ?? {})
            .filter(([k]) => k !== "other")
            .map(([key, label]) => (
              <label key={key} className={`chip ${state.types.includes(key) ? "chip-on" : ""}`}>
                <input
                  type="checkbox"
                  checked={state.types.includes(key)}
                  onChange={() => onChange({ ...state, types: toggle(state.types, key) })}
                />
                {label}
              </label>
            ))}
        </div>
      </fieldset>

      <fieldset>
        <legend>Received between</legend>
        <div className="date-row">
          <input
            type="date"
            aria-label="Received from"
            value={state.receivedFrom}
            onChange={(e) => onChange({ ...state, receivedFrom: e.target.value })}
          />
          <span aria-hidden="true">–</span>
          <input
            type="date"
            aria-label="Received to"
            value={state.receivedTo}
            onChange={(e) => onChange({ ...state, receivedTo: e.target.value })}
          />
        </div>
      </fieldset>

      <details className="filters-advanced">
        <summary>Advanced</summary>

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
      </details>
    </details>
    </>
  );
}

function statusesCustomised(s: SearchState): boolean {
  if (s.statuses.length !== DEFAULT_STATUSES.length) return true;
  const set = new Set(s.statuses);
  return DEFAULT_STATUSES.some((k) => !set.has(k));
}
