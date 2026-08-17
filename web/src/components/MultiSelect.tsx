import { useEffect, useRef, useState } from "react";

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
}

/**
 * Compact dropdown multi-select — a trigger that summarises the selection and a
 * popover of checkboxes. Used where a chip row would not scale.
 *
 * Deliberately identical for every filter. A type-to-filter box used to appear
 * once a list passed ten options, which meant Status alone grew a search field
 * its eight-to-twelve entries never needed, and the three dropdowns no longer
 * looked like the same control. If a list ever gets genuinely long (the council
 * list would, at all 31 local authorities) it can come back for all of them.
 */
export default function MultiSelect({ allLabel, options, selected, onChange, ariaLabel }: Props) {
  const [open, setOpen] = useState(false);
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
          <div className="ms-options">
            {options.map((o) => (
              <label key={o.id} className="ms-option">
                <input
                  type="checkbox"
                  checked={selected.includes(o.id)}
                  onChange={() => toggle(o.id)}
                />
                {o.label}
              </label>
            ))}
          </div>
          {/* "Clear selection" sat here; with a handful of options it is quicker
              to untick than to find a bulk action, and every chosen option is
              already one tap from being removed. Done just closes the list. */}
          <button type="button" className="ms-done" onClick={() => setOpen(false)}>
            Done
          </button>
        </div>
      )}
    </div>
  );
}
