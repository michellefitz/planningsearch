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
          placeholder="Address, area, reference, applicant or keyword…"
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
        <button type="submit" className="btn btn-primary">
          Search
        </button>
        <button
          type="button"
          className="btn btn-icon"
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
