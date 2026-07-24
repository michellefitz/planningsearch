import { DEFAULT_STATUSES, type Meta, type SearchState } from "../api";
import { STATUS_STYLE } from "./MapView";

interface Props {
  meta: Meta | null;
  state: SearchState;
  onChange: (next: SearchState) => void;
}

function toggle(list: string[], value: string): string[] {
  return list.includes(value) ? list.filter((v) => v !== value) : [...list, value];
}

export default function FiltersBar({ meta, state, onChange }: Props) {
  return (
    <details className="filters" open={false}>
      <summary>
        Filters
        {countActive(state) > 0 && <span className="filter-badge">{countActive(state)}</span>}
      </summary>
      <fieldset>
        <legend>Authority</legend>
        <div className="chip-row">
          {meta?.authorities.map((a) => (
            <label key={a.id} className={`chip ${state.authorities.includes(a.id) ? "chip-on" : ""}`}>
              <input
                type="checkbox"
                checked={state.authorities.includes(a.id)}
                onChange={() => onChange({ ...state, authorities: toggle(state.authorities, a.id) })}
              />
              {a.short_name}
            </label>
          ))}
        </div>
      </fieldset>
      <fieldset>
        <legend>Status</legend>
        <div className="chip-row">
          {Object.entries(STATUS_STYLE)
            .filter(([k]) => k !== "unknown")
            .map(([key, s]) => (
              <label key={key} className={`chip ${state.statuses.includes(key) ? "chip-on" : ""}`}>
                <input
                  type="checkbox"
                  checked={state.statuses.includes(key)}
                  onChange={() => onChange({ ...state, statuses: toggle(state.statuses, key) })}
                />
                <span className="dot" style={{ background: s.color }} aria-hidden="true" />
                {s.label}
              </label>
            ))}
        </div>
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
      <fieldset>
        <legend>More</legend>
        <label className="toggle-row">
          <input
            type="checkbox"
            checked={state.domesticOnly}
            onChange={(e) => onChange({ ...state, domesticOnly: e.target.checked })}
          />
          Domestic only <em className="hint">(best-effort filter, not an official category)</em>
        </label>
        <label className="toggle-row">
          <input
            type="checkbox"
            checked={state.appealedOnly}
            onChange={(e) => onChange({ ...state, appealedOnly: e.target.checked })}
          />
          Appealed to An Coimisiún Pleanála <em className="hint">(has an appeal on record)</em>
        </label>
        <label className="toggle-row">
          <input
            type="checkbox"
            checked={state.commencedOnly}
            onChange={(e) => onChange({ ...state, commencedOnly: e.target.checked })}
          />
          Work commenced <em className="hint">(commencement notice filed with building control)</em>
        </label>
        <label className="toggle-row">
          <input
            type="checkbox"
            checked={state.useMapArea}
            onChange={(e) => onChange({ ...state, useMapArea: e.target.checked })}
          />
          Limit to current map area
        </label>
        <label className="toggle-row">
          Sort by{" "}
          <select
            value={state.sort}
            onChange={(e) => onChange({ ...state, sort: e.target.value })}
            aria-label="Sort results"
          >
            <option value="received">Date received</option>
            <option value="decision">Decision date</option>
            <option value="distance">Distance</option>
            <option value="relevance">Relevance</option>
          </select>
        </label>
      </fieldset>
    </details>
  );
}

/** The Status filter counts toward the badge only when narrowed from its
 *  default (everything except invalid/incomplete) — the default view is "clean",
 *  not a filtered state the user set. */
function statusesCustomised(s: SearchState): boolean {
  if (s.statuses.length !== DEFAULT_STATUSES.length) return true;
  const set = new Set(s.statuses);
  return DEFAULT_STATUSES.some((k) => !set.has(k));
}

function countActive(s: SearchState): number {
  return (
    s.authorities.length +
    (statusesCustomised(s) ? 1 : 0) +
    s.types.length +
    (s.domesticOnly ? 1 : 0) +
    (s.appealedOnly ? 1 : 0) +
    (s.commencedOnly ? 1 : 0) +
    (s.receivedFrom ? 1 : 0) +
    (s.receivedTo ? 1 : 0) +
    (s.useMapArea ? 1 : 0)
  );
}
