import { useEffect, useRef, useState } from "react";
import { api } from "../api";

interface Props {
  value: string;
  onChange: (q: string) => void;
  onSubmit: (q: string) => void;
  onNearMe: () => void;
}

/**
 * One row of the suggestion list. The first is always the query itself: the
 * list is addresses and areas the register knows, and offering only those made
 * it look like you had to pick one of them. Typing "Terenure" and pressing
 * Search has always worked — it just never looked like an option.
 */
type Option = { kind: "query" | "suggestion"; text: string };

export default function SearchBar({ value, onChange, onSubmit, onNearMe }: Props) {
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const [open, setOpen] = useState(false);
  // Keyboard cursor into the options; -1 means "typing, nothing chosen".
  const [active, setActive] = useState(-1);
  const debounceRef = useRef<number>();
  const inputRef = useRef<HTMLInputElement>(null);

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

  const options: Option[] = [
    ...(value.trim() ? [{ kind: "query" as const, text: value.trim() }] : []),
    ...suggestions.map((text) => ({ kind: "suggestion" as const, text })),
  ];

  /**
   * Hand the search off and get out of the way.
   *
   * The keyboard used to stay up over the results — on a phone that is half
   * the screen, covering the map you just searched — because nothing ever took
   * focus off the input. Blurring it is what dismisses the keyboard on iOS.
   */
  const submit = (q: string) => {
    setOpen(false);
    setActive(-1);
    inputRef.current?.blur();
    onSubmit(q);
  };

  const take = (o: Option) => {
    // A suggestion replaces what was typed; the query row searches it as-is.
    if (o.kind === "suggestion") onChange(o.text);
    submit(o.text);
  };

  const clear = () => {
    onChange("");
    setSuggestions([]);
    setOpen(false);
    setActive(-1);
    inputRef.current?.focus();
  };

  return (
    <div className="search-bar">
      <form
        role="search"
        onSubmit={(e) => {
          e.preventDefault();
          submit(value);
        }}
      >
        {/* Wrapper so the clear button can sit inside the field rather than
            beside it, where it would take width from the placeholder. */}
        <div className="search-field">
          <input
            ref={inputRef}
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
            onFocus={() => setOpen(options.length > 1)}
            onBlur={() => window.setTimeout(() => setOpen(false), 150)}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                // First Escape closes the list; a second clears the field, the
                // way a native search box behaves.
                if (open) {
                  setOpen(false);
                  setActive(-1);
                } else if (value) {
                  clear();
                }
                return;
              }
              if (!open || options.length === 0) return;
              if (e.key === "ArrowDown") {
                e.preventDefault();
                setActive((a) => (a + 1) % options.length);
              } else if (e.key === "ArrowUp") {
                e.preventDefault();
                setActive((a) => (a <= 0 ? options.length - 1 : a - 1));
              } else if (e.key === "Enter" && active >= 0) {
                e.preventDefault();
                take(options[active]);
              }
            }}
            autoComplete="off"
          />
          {/* WebKit has a native one, but not on iOS, and it never appears in
              Firefox — so ours is drawn and the native one hidden in CSS. */}
          {value && (
            <button
              type="button"
              className="search-clear"
              onClick={clear}
              aria-label="Clear search"
            >
              <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
                <path d="M2 2l8 8M10 2l-8 8" />
              </svg>
            </button>
          )}
        </div>
        {/* A magnifier, not the word. The label cost the input enough width to
            truncate its own placeholder on a phone, and on desktop it was the
            heaviest thing in a row whose job is the text field. aria-label
            carries the name, so the button is never unnamed. */}
        <button type="submit" className="btn btn-primary btn-search" aria-label="Search">
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
      {open && options.length > 0 && (
        <ul className="suggestions" id="search-suggestions" role="listbox" aria-label="Search suggestions">
          {options.map((o, i) => (
            <li key={`${o.kind}-${o.text}`} id={`sugg-${i}`} role="option" aria-selected={i === active}>
              <button
                type="button"
                tabIndex={-1}
                className={`${o.kind === "query" ? "sugg-query" : ""} ${i === active ? "sugg-active" : ""}`}
                onMouseDown={(e) => {
                  e.preventDefault();
                  take(o);
                }}
                onMouseEnter={() => setActive(i)}
              >
                {o.kind === "query" ? (
                  <>
                    <svg className="sugg-icon" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true">
                      <circle cx="10.5" cy="10.5" r="6.5" />
                      <path d="M15.5 15.5 21 21" />
                    </svg>
                    <span>
                      Search for <strong>{o.text}</strong>
                    </span>
                  </>
                ) : (
                  o.text
                )}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
