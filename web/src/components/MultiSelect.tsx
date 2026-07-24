import { useEffect, useMemo, useRef, useState } from "react";

export interface MultiSelectOption {
  id: string;
  label: string;
}

interface Props {
  /** Shown on the trigger when nothing is selected, e.g. "All councils". */
  allLabel: string;
  options: MultiSelectOption[];
  selected: string[];
  onChange: (next: string[]) => void;
  /** Accessible name for the trigger, e.g. "Filter by council". */
  ariaLabel: string;
  /** Show a type-to-filter box once the list gets long. */
  filterThreshold?: number;
}

/**
 * Compact dropdown multi-select — a trigger that summarises the selection and a
 * popover of checkboxes. Used where a chip row would not scale: the council list
 * starts at five authorities but grows toward all 31 local authorities.
 */
export default function MultiSelect({
  allLabel,
  options,
  selected,
  onChange,
  ariaLabel,
  filterThreshold = 10,
}: Props) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const rootRef = useRef<HTMLDivElement>(null);

  // Close on outside click or Escape.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q ? options.filter((o) => o.label.toLowerCase().includes(q)) : options;
  }, [options, query]);

  const summary =
    selected.length === 0
      ? allLabel
      : selected.length === 1
        ? (options.find((o) => o.id === selected[0])?.label ?? `1 selected`)
        : `${selected.length} selected`;

  const toggle = (id: string) =>
    onChange(selected.includes(id) ? selected.filter((v) => v !== id) : [...selected, id]);

  return (
    <div className="ms" ref={rootRef}>
      <button
        type="button"
        className={`ms-trigger ${selected.length ? "ms-trigger-on" : ""}`}
        aria-expanded={open}
        aria-haspopup="true"
        aria-label={ariaLabel}
        onClick={() => setOpen((o) => !o)}
      >
        <span className="ms-summary">{summary}</span>
        <span className="ms-caret" aria-hidden="true" />
      </button>
      {open && (
        <div className="ms-panel">
          {options.length > filterThreshold && (
            <input
              type="text"
              className="ms-filter"
              placeholder="Type to filter…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              autoFocus
            />
          )}
          <div className="ms-options">
            {visible.map((o) => (
              <label key={o.id} className="ms-option">
                <input
                  type="checkbox"
                  checked={selected.includes(o.id)}
                  onChange={() => toggle(o.id)}
                />
                {o.label}
              </label>
            ))}
            {visible.length === 0 && <p className="ms-empty">No matches</p>}
          </div>
          {selected.length > 0 && (
            <button type="button" className="ms-clear" onClick={() => onChange([])}>
              Clear selection
            </button>
          )}
        </div>
      )}
    </div>
  );
}
