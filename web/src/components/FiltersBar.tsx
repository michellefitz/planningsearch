import type { Meta, SearchState } from "../api";
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
                <span className="status-dot" style={{ background: s.color }} aria-hidden="true">
                  {s.letter}
                </span>
                {s.label}
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

function countActive(s: SearchState): number {
  return (
    s.authorities.length +
    s.statuses.length +
    (s.domesticOnly ? 1 : 0) +
    (s.receivedFrom ? 1 : 0) +
    (s.receivedTo ? 1 : 0) +
    (s.useMapArea ? 1 : 0)
  );
}
