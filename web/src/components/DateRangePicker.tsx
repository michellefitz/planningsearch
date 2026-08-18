import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { releasePanel, revealPanel } from "../revealPanel";

/**
 * Received-date range picker (PRD F2): one control that sets both ends of the
 * range in a single flow — preset chips for the common "what's popped up
 * recently" looks, and a hotel-style calendar underneath (first tap starts the
 * range, second tap ends it, with a hover preview between). Expands inline
 * rather than floating so it works in the narrow filter column and the mobile
 * bottom sheet without clipping.
 */

interface Props {
  from: string; // YYYY-MM-DD or ""
  to: string; // YYYY-MM-DD or ""
  onChange: (from: string, to: string) => void;
}

/** Local-time YYYY-MM-DD (toISOString would shift the day across UTC). */
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

/** "12 Jun 2026" — or without the year when it can be inferred from context. */
function shortDate(s: string, withYear = true): string {
  const d = parse(s);
  if (!d) return s;
  const base = `${d.getDate()} ${MONTHS[d.getMonth()].slice(0, 3)}`;
  return withYear ? `${base} ${d.getFullYear()}` : base;
}

interface Preset {
  label: string;
  /** Start of the range; the end stays open ("since …"). */
  from: () => Date;
}

const PRESETS: Preset[] = [
  { label: "Last week", from: () => { const d = new Date(); d.setDate(d.getDate() - 7); return d; } },
  { label: "Last month", from: () => { const d = new Date(); d.setMonth(d.getMonth() - 1); return d; } },
  { label: "Last 3 months", from: () => { const d = new Date(); d.setMonth(d.getMonth() - 3); return d; } },
  { label: "This year", from: () => new Date(new Date().getFullYear(), 0, 1) },
];

/**
 * Always the dates themselves, never a preset's name.
 *
 * "Last month" is ambiguous — the 1st to the 31st, or the 15th to the 15th? —
 * and the two readings pick out different applications. The chips used to
 * carry their resolved range as a second line to answer that, which cost most
 * of the panel's width. Since a chip now just fills the calendar in, the
 * answer is visible in the calendar and here, and the chips can be one word
 * again.
 */
function triggerLabel(from: string, to: string): string {
  if (from && to) {
    const sameYear = from.slice(0, 4) === to.slice(0, 4);
    return `${shortDate(from, !sameYear)} – ${shortDate(to)}`;
  }
  if (from) return `Since ${shortDate(from)}`;
  if (to) return `Until ${shortDate(to)}`;
  return "Any dates";
}

export default function DateRangePicker({ from, to, onChange }: Props) {
  const [open, setOpen] = useState(false);
  // Month shown in the calendar (first of month). Follows the range start so
  // reopening lands where the user was looking.
  const [month, setMonth] = useState<Date>(() => {
    const d = parse(from) ?? new Date();
    return new Date(d.getFullYear(), d.getMonth(), 1);
  });
  const [hover, setHover] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  // After paint, so the calendar has its real height before anything is
  // measured against the room available for it.
  useLayoutEffect(() => {
    if (open) revealPanel(panelRef.current);
    else releasePanel(panelRef.current);
  }, [open]);

  useEffect(() => {
    // Drop any hover preview when the panel closes — a stale hovered day would
    // otherwise paint a phantom range the next time it opens.
    if (!open) {
      setHover(null);
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
    PRESETS.find((p) => from === fmt(p.from()) && to === today)?.label ?? null;

  const pickDay = (day: string) => {
    // Hotel-selector flow: first tap starts the range, second tap ends it (and
    // closes); tapping before the start restarts from that day instead.
    if (!from || (from && to)) {
      onChange(day, "");
    } else if (day < from) {
      onChange(day, "");
    } else {
      onChange(from, day);
      setOpen(false);
    }
  };

  /**
   * A shortcut for two taps on the calendar, and nothing more. It used to
   * apply an open-ended range and close the panel, which made the chips a
   * second, parallel way of setting dates — with their own labels to reconcile
   * against whatever the calendar showed. Now they fill both ends in and leave
   * the panel open, so the calendar is the single answer to "what is selected"
   * and the range is still there to adjust by hand.
   */
  const applyPreset = (p: Preset) => {
    const start = p.from();
    onChange(fmt(start), today);
    // Land on the month holding the end of the range: it is today's month for
    // every preset, so the view stays put as you try them.
    const end = new Date();
    setMonth(new Date(end.getFullYear(), end.getMonth(), 1));
  };

  // Calendar grid for the shown month, weeks starting Monday.
  const first = new Date(month.getFullYear(), month.getMonth(), 1);
  const daysInMonth = new Date(month.getFullYear(), month.getMonth() + 1, 0).getDate();
  const leading = (first.getDay() + 6) % 7; // Mon=0 … Sun=6
  const cells: Array<string | null> = [
    ...Array.from({ length: leading }, () => null),
    ...Array.from({ length: daysInMonth }, (_, i) =>
      fmt(new Date(month.getFullYear(), month.getMonth(), i + 1))
    ),
  ];
  const atCurrentMonth =
    month.getFullYear() === new Date().getFullYear() && month.getMonth() === new Date().getMonth();
  // The range highlight previews to the hovered day while the end is unpicked.
  const rangeEnd = to || (from && hover && hover > from ? hover : "");

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
          <div className="dr-cal" role="application" aria-label="Choose a date range">
            <div className="dr-nav">
              <button
                type="button"
                className="dr-navbtn"
                aria-label="Previous month"
                onClick={() => setMonth(new Date(month.getFullYear(), month.getMonth() - 1, 1))}
              >
                ‹
              </button>
              <span className="dr-month">
                {MONTHS[month.getMonth()]} {month.getFullYear()}
              </span>
              <button
                type="button"
                className="dr-navbtn"
                aria-label="Next month"
                disabled={atCurrentMonth}
                onClick={() => setMonth(new Date(month.getFullYear(), month.getMonth() + 1, 1))}
              >
                ›
              </button>
            </div>
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
            <div className="dr-foot">
              <span className="hint">
                {from && !to
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
