import { useEffect, useRef, useState } from "react";
import { api } from "../api";

interface Props {
  value: string;
  onChange: (q: string) => void;
  onSubmit: (q: string) => void;
  onNearMe: () => void;
}

export default function SearchBar({ value, onChange, onSubmit, onNearMe }: Props) {
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const [open, setOpen] = useState(false);
  // Keyboard cursor into the suggestions; -1 means "typing, nothing chosen".
  const [active, setActive] = useState(-1);
  const debounceRef = useRef<number>();

  useEffect(() => {
    window.clearTimeout(debounceRef.current);
    if (value.trim().length < 2) {
      setSuggestions([]);
      return;
    }
    debounceRef.current = window.setTimeout(async () => {
      try {
        const { suggestions } = await api.suggest(value);
        setSuggestions(suggestions);
        setActive(-1);
        setOpen(suggestions.length > 0);
      } catch {
        setSuggestions([]);
      }
    }, 200);
    return () => window.clearTimeout(debounceRef.current);
  }, [value]);

  const take = (s: string) => {
    onChange(s);
    setOpen(false);
    onSubmit(s);
  };

  return (
    <div className="search-bar">
      <form
        role="search"
        onSubmit={(e) => {
          e.preventDefault();
          setOpen(false);
          onSubmit(value);
        }}
      >
        <input
          type="search"
          className="search-input"
          placeholder="Address, area, reference or keyword…"
          aria-label="Search planning applications across all five authorities"
          role="combobox"
          aria-expanded={open}
          aria-controls="search-suggestions"
          aria-autocomplete="list"
          aria-activedescendant={open && active >= 0 ? `sugg-${active}` : undefined}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onFocus={() => setOpen(suggestions.length > 0)}
          onBlur={() => window.setTimeout(() => setOpen(false), 150)}
          onKeyDown={(e) => {
            if (!open || suggestions.length === 0) return;
            if (e.key === "ArrowDown") {
              e.preventDefault();
              setActive((a) => (a + 1) % suggestions.length);
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              setActive((a) => (a <= 0 ? suggestions.length - 1 : a - 1));
            } else if (e.key === "Enter" && active >= 0) {
              e.preventDefault();
              take(suggestions[active]);
            } else if (e.key === "Escape") {
              setOpen(false);
              setActive(-1);
            }
          }}
          autoComplete="off"
        />
        {/* Labelled on desktop, a magnifier on a phone — the word cost the
            input enough width to truncate its own placeholder. aria-label
            carries the name either way, so the button is never unnamed. */}
        <button type="submit" className="btn btn-primary btn-search" aria-label="Search">
          <span className="btn-search-label">Search</span>
          <svg
            className="btn-search-icon"
            aria-hidden="true"
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
          >
            <circle cx="10.5" cy="10.5" r="6.5" />
            <path d="M15.5 15.5 21 21" />
          </svg>
        </button>
        {/* Hidden on mobile: the map's own locate control does the same job,
            sits under the zoom buttons where a thumb already is, and is the
            one people reach for while looking at the map. */}
        <button
          type="button"
          className="btn btn-icon near-me-btn"
          onClick={onNearMe}
          title="Search near my location"
          aria-label="Search near my location"
        >
          <svg
            aria-hidden="true"
            width="15"
            height="15"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
          >
            <circle cx="12" cy="12" r="3.4" />
            <path d="M12 2.5V6M12 18v3.5M21.5 12H18M6 12H2.5" />
          </svg>
        </button>
      </form>
      {open && (
        <ul className="suggestions" id="search-suggestions" role="listbox" aria-label="Search suggestions">
          {suggestions.map((s, i) => (
            <li key={s} id={`sugg-${i}`} role="option" aria-selected={i === active}>
              <button
                type="button"
                tabIndex={-1}
                className={i === active ? "sugg-active" : ""}
                onMouseDown={(e) => {
                  e.preventDefault();
                  take(s);
                }}
                onMouseEnter={() => setActive(i)}
              >
                {s}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
