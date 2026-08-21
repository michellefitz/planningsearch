import { useEffect, useRef, useState, type ReactNode } from "react";

/**
 * The actions on a row, out of the way until asked for.
 *
 * Every saved row carried a bell, a full `List…` select and an X at the same
 * visual weight as the application itself. On desktop they at least waited for
 * a hover; on a phone — where the register is actually read — they were pinned
 * visible, so a control used occasionally had permanent equal billing with the
 * thing it acts on, and the one that permanently deleted a save looked exactly
 * like the one that closes a chip.
 *
 * The bell stays on the row: it is a state indicator as much as a control, and
 * seeing at a glance whether an application is alerting is worth its space.
 * Everything else lives here.
 */
export function RowMenu({
  label,
  children,
}: {
  label: string;
  /** Rendered inside the menu; call `close` from an item's handler. */
  children: (close: () => void) => ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent | TouchEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    // Capture, because the row underneath stops propagation of its own clicks.
    document.addEventListener("mousedown", onDown, true);
    document.addEventListener("touchstart", onDown, true);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown, true);
      document.removeEventListener("touchstart", onDown, true);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <span className="row-menu" ref={wrapRef} onClick={(e) => e.stopPropagation()}>
      <button
        type="button"
        className={`row-menu-btn${open ? " row-menu-btn-open" : ""}`}
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        {/* Three dots, drawn rather than typed: the character renders at wildly
            different sizes across platforms and this has to line up with the
            bell beside it. */}
        <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
          <circle cx="3" cy="7" r="1.35" fill="currentColor" />
          <circle cx="7" cy="7" r="1.35" fill="currentColor" />
          <circle cx="11" cy="7" r="1.35" fill="currentColor" />
        </svg>
      </button>
      {open && (
        <span className="row-menu-pop" role="menu">
          {children(() => setOpen(false))}
        </span>
      )}
    </span>
  );
}
