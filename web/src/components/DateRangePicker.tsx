import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { releasePanel, revealPanel } from "../revealPanel";

interface Props {
  from: string;
  to: string;
  onChange: (from: string, to: string) => void;
}

function fmt(d: Date): string {
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${m}-${day}`;
}

function parse(s: string): Date | null {
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : null;
}

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];
const MONTHS_SHORT = MONTHS.map((m) => m.slice(0, 3));

function shortDate(s: string, withYear = true): string {
  const d = parse(s);
  if (!d) return s;
  const base = `${d.getDate()} ${MONTHS_SHORT[d.getMonth()]}`;
  return withYear ? `${base} ${d.getFullYear()}` : base;
}

interface Preset {
  label: string;
  from: () => Date;
  to?: () => Date;
}

const PRESETS: Preset[] = [
  { label: "Last month", from: () => { const d = new Date(); d.setMonth(d.getMonth() - 1); return d; } },
  { label: "Last 3 months", from: () => { const d = new Date(); d.setMonth(d.getMonth() - 3); return d; } },
  { label: "Last year", from: () => { const d = new Date(); d.setFullYear(d.getFullYear() - 1); return d; } },
];

function triggerLabel(from: string, to: string): string {
  if (from && to) {
    const sameYear = from.slice(0, 4) === to.slice(0, 4);
    return `${shortDate(from, !sameYear)} – ${shortDate(to)}`;
  }
  if (from) return `Since ${shortDate(from)}`;
  if (to) return `Until ${shortDate(to)}`;
  return "Any dates";
}

type View = "calendar" | "year" | "month";

export default function DateRangePicker({ from, to, onChange }: Props) {
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<View>("calendar");
  const [month, setMonth] = useState<Date>(() => {
    const d = parse(from) ?? new Date();
    return new Date(d.getFullYear(), d.getMonth(), 1);
  });
  const [hover, setHover] = useState<string | null>(null);
  const [fromInput, setFromInput] = useState(from);
  const [toInput, setToInput] = useState(to);
  const rootRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => { setFromInput(from); }, [from]);
  useEffect(() => { setToInput(to); }, [to]);

  useLayoutEffect(() => {
    if (open) revealPanel(panelRef.current);
    else releasePanel(panelRef.current);
  }, [open]);

  useEffect(() => {
    if (!open) {
      setHover(null);
      setView("calendar");
      return;
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    const onDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    document.addEventListener("mousedown", onDown);
    return () => {
      window.removeEventListener("keydown", onKey);
      document.removeEventListener("mousedown", onDown);
    };
  }, [open]);

  const today = fmt(new Date());

  const activePreset =
    PRESETS.find((p) => {
      const pf = fmt(p.from());
      const pt = p.to ? fmt(p.to()) : today;
      return from === pf && to === pt;
    })?.label ?? null;

  const pickDay = (day: string) => {
    if (!from || (from && to)) {
      onChange(day, "");
    } else if (day < from) {
      onChange(day, "");
    } else {
      onChange(from, day);
      setOpen(false);
    }
  };

  const applyPreset = (p: Preset) => {
    const start = p.from();
    const end = p.to ? p.to() : new Date();
    onChange(fmt(start), fmt(end));
    setMonth(new Date(end.getFullYear(), end.getMonth(), 1));
  };

  const commitFromInput = () => {
    const d = parse(fromInput);
    if (d) {
      onChange(fromInput, to);
      setMonth(new Date(d.getFullYear(), d.getMonth(), 1));
    } else if (!fromInput.trim()) {
      onChange("", to);
    } else {
      setFromInput(from);
    }
  };

  const commitToInput = () => {
    const d = parse(toInput);
    if (d) {
      onChange(from, toInput);
    } else if (!toInput.trim()) {
      onChange(from, "");
    } else {
      setToInput(to);
    }
  };

  const pickYear = (year: number) => {
    setMonth(new Date(year, month.getMonth(), 1));
    setView("month");
  };

  const pickMonth = (m: number) => {
    setMonth(new Date(month.getFullYear(), m, 1));
    setView("calendar");
  };

  const first = new Date(month.getFullYear(), month.getMonth(), 1);
  const daysInMonth = new Date(month.getFullYear(), month.getMonth() + 1, 0).getDate();
  const leading = (first.getDay() + 6) % 7;
  const cells: Array<string | null> = [
    ...Array.from({ length: leading }, () => null),
    ...Array.from({ length: daysInMonth }, (_, i) =>
      fmt(new Date(month.getFullYear(), month.getMonth(), i + 1))
    ),
  ];
  const atCurrentMonth =
    month.getFullYear() === new Date().getFullYear() && month.getMonth() === new Date().getMonth();
  const rangeEnd = to || (from && hover && hover > from ? hover : "");

  const nowYear = new Date().getFullYear();
  const yearGridStart = Math.floor(month.getFullYear() / 12) * 12;

  return (
    <div className="daterange" ref={rootRef}>
      <button
        type="button"
        className={`dr-trigger ${from || to ? "dr-active" : ""}`}
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <span>{triggerLabel(from, to)}</span>
        <span className="dr-caret" aria-hidden="true" />
      </button>
      {open && (
        <div className="dr-panel" ref={panelRef}>
          <div className="chip-row">
            {PRESETS.map((p) => (
              <button
                key={p.label}
                type="button"
                className={`chip ${activePreset === p.label ? "chip-on" : ""}`}
                onClick={() => applyPreset(p)}
              >
                {p.label}
              </button>
            ))}
          </div>

          <div className="dr-inputs">
            <label>
              <span>From</span>
              <input
                type="text"
                inputMode="numeric"
                placeholder="YYYY-MM-DD"
                value={fromInput}
                onChange={(e) => setFromInput(e.target.value)}
                onBlur={commitFromInput}
                onKeyDown={(e) => { if (e.key === "Enter") commitFromInput(); }}
              />
            </label>
            <span className="dr-dash">–</span>
            <label>
              <span>To</span>
              <input
                type="text"
                inputMode="numeric"
                placeholder="YYYY-MM-DD"
                value={toInput}
                onChange={(e) => setToInput(e.target.value)}
                onBlur={commitToInput}
                onKeyDown={(e) => { if (e.key === "Enter") commitToInput(); }}
              />
            </label>
            {from && !to && (
              <button
                type="button"
                className="dr-today-btn"
                onClick={() => onChange(from, today)}
              >
                Today
              </button>
            )}
          </div>

          <div className="dr-cal" role="application" aria-label="Choose a date range">
            <div className="dr-nav">
              {view === "calendar" && (
                <button
                  type="button"
                  className="dr-navbtn"
                  aria-label="Previous month"
                  onClick={() => setMonth(new Date(month.getFullYear(), month.getMonth() - 1, 1))}
                >
                  ‹
                </button>
              )}
              {view === "year" && (
                <button
                  type="button"
                  className="dr-navbtn"
                  aria-label="Previous years"
                  onClick={() => setMonth(new Date(month.getFullYear() - 12, month.getMonth(), 1))}
                >
                  ‹
                </button>
              )}
              <button
                type="button"
                className="dr-month dr-month-btn"
                onClick={() => setView(view === "calendar" ? "year" : "calendar")}
                aria-label="Pick year and month"
              >
                {view === "year"
                  ? `${yearGridStart} – ${yearGridStart + 11}`
                  : view === "month"
                    ? String(month.getFullYear())
                    : `${MONTHS[month.getMonth()]} ${month.getFullYear()}`}
              </button>
              {view === "calendar" && (
                <button
                  type="button"
                  className="dr-navbtn"
                  aria-label="Next month"
                  disabled={atCurrentMonth}
                  onClick={() => setMonth(new Date(month.getFullYear(), month.getMonth() + 1, 1))}
                >
                  ›
                </button>
              )}
              {view === "year" && (
                <button
                  type="button"
                  className="dr-navbtn"
                  aria-label="Next years"
                  disabled={yearGridStart + 12 > nowYear}
                  onClick={() => setMonth(new Date(month.getFullYear() + 12, month.getMonth(), 1))}
                >
                  ›
                </button>
              )}
            </div>

            {view === "calendar" && (
              <div className="dr-grid" onMouseLeave={() => setHover(null)}>
                {["M", "T", "W", "T", "F", "S", "S"].map((w, i) => (
                  <span key={`w${i}`} className="dr-wd" aria-hidden="true">
                    {w}
                  </span>
                ))}
                {cells.map((day, i) =>
                  day === null ? (
                    <span key={`b${i}`} />
                  ) : (
                    <button
                      key={day}
                      type="button"
                      className={[
                        "dr-day",
                        day === from ? "dr-start" : "",
                        day === rangeEnd && rangeEnd ? "dr-end" : "",
                        from && rangeEnd && day > from && day < rangeEnd ? "dr-in" : "",
                        day === today ? "dr-today" : "",
                      ]
                        .filter(Boolean)
                        .join(" ")}
                      disabled={day > today}
                      aria-label={shortDate(day)}
                      aria-pressed={day === from || day === to}
                      onClick={() => pickDay(day)}
                      onMouseEnter={() => setHover(day)}
                    >
                      {Number(day.slice(8))}
                    </button>
                  )
                )}
              </div>
            )}

            {view === "year" && (
              <div className="dr-year-grid">
                {Array.from({ length: 12 }, (_, i) => yearGridStart + i).map((y) => (
                  <button
                    key={y}
                    type="button"
                    className={`dr-year-cell ${y === month.getFullYear() ? "dr-year-active" : ""}`}
                    disabled={y > nowYear}
                    onClick={() => pickYear(y)}
                  >
                    {y}
                  </button>
                ))}
              </div>
            )}

            {view === "month" && (
              <div className="dr-month-grid">
                {MONTHS_SHORT.map((m, i) => {
                  const isFuture = month.getFullYear() === nowYear && i > new Date().getMonth();
                  return (
                    <button
                      key={m}
                      type="button"
                      className={`dr-month-cell ${i === month.getMonth() ? "dr-month-active" : ""}`}
                      disabled={isFuture}
                      onClick={() => pickMonth(i)}
                    >
                      {m}
                    </button>
                  );
                })}
              </div>
            )}

            <div className="dr-foot">
              <span className="hint">
                {view !== "calendar"
                  ? "Pick a year, then a month"
                  : from && !to
                    ? "Now pick the end date — or leave it open"
                    : "Tap a start date, then an end date"}
              </span>
              {(from || to) && (
                <button
                  type="button"
                  className="dr-clear"
                  onClick={() => {
                    onChange("", "");
                    setHover(null);
                  }}
                >
                  Clear
                </button>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
