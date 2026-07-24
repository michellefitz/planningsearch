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
        setOpen(suggestions.length > 0);
      } catch {
        setSuggestions([]);
      }
    }, 200);
    return () => window.clearTimeout(debounceRef.current);
  }, [value]);

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
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onFocus={() => setOpen(suggestions.length > 0)}
          onBlur={() => window.setTimeout(() => setOpen(false), 150)}
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
          <span aria-hidden="true">📍</span>
        </button>
      </form>
      {open && (
        <ul className="suggestions" role="listbox" aria-label="Search suggestions">
          {suggestions.map((s) => (
            <li key={s} role="option" aria-selected="false">
              <button
                type="button"
                onMouseDown={(e) => {
                  e.preventDefault();
                  onChange(s);
                  setOpen(false);
                  onSubmit(s);
                }}
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
