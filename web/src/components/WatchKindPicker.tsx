import {
  WATCH_KIND_LABELS,
  WATCH_KIND_ORDER,
  type WatchKind,
} from "../accountApi";

/**
 * "What do you want to watch for?"
 *
 * A watched area used to alert on new applications and commencement notices
 * and say neither — the dashboard offered "everything" without ever saying
 * what everything was, so the one thing a watcher most wants to know about
 * their own watch was the thing it would not tell them.
 *
 * Checkboxes rather than chips: these are not exclusive, several are usually
 * wanted at once, and a checkbox is the control that says so without being
 * taught. Each carries a line of what it actually means, because "Decisions"
 * and "Appeals" are the app's words, not the reader's.
 */
export function WatchKindPicker({
  kinds,
  onChange,
  idPrefix = "watch-kind",
}: {
  kinds: WatchKind[];
  onChange: (kinds: WatchKind[]) => void;
  idPrefix?: string;
}) {
  const toggle = (kind: WatchKind) => {
    const next = kinds.includes(kind) ? kinds.filter((k) => k !== kind) : [...kinds, kind];
    // Stable order, so the list reads the same here, on the dashboard and in
    // the email, whatever order they were ticked in.
    onChange(WATCH_KIND_ORDER.filter((k) => next.includes(k)));
  };
  return (
    <fieldset className="watch-kinds">
      <legend>What do you want to watch for?</legend>
      {WATCH_KIND_ORDER.map((kind) => {
        const { label, hint } = WATCH_KIND_LABELS[kind];
        const id = `${idPrefix}-${kind}`;
        return (
          <div className="watch-kind" key={kind}>
            <input
              type="checkbox"
              id={id}
              checked={kinds.includes(kind)}
              onChange={() => toggle(kind)}
            />
            <label htmlFor={id}>
              <span className="watch-kind-label">{label}</span>
              <span className="watch-kind-hint">{hint}</span>
            </label>
          </div>
        );
      })}
      {/* A watch that alerts on nothing is a watch that will feel broken. Said
          here rather than enforced silently, so the empty state is the
          reader's own doing and they can see it. */}
      {kinds.length === 0 && (
        <p className="watch-kinds-warn">
          Pick at least one, or this area will never send you anything.
        </p>
      )}
    </fieldset>
  );
}
