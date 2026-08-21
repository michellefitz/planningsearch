/**
 * Removals you can take back.
 *
 * Unsaving an application used to be a bare X that deleted immediately, with
 * no confirmation and no way back — and on a phone it sat at full weight on
 * every row, beside a list dropdown, indistinguishable from a dismiss. People
 * pressed it without knowing what it did.
 *
 * A confirm dialog would fix the accident and cost everyone else a click. This
 * does the opposite: the row goes at once and the delete does not happen at
 * all until the undo window lapses, so taking it back is free and restores the
 * save exactly as it was — its alerts setting, its list membership, its whole
 * history — because nothing was ever deleted.
 *
 * Pending work must survive the panel closing, so `flush` commits everything
 * still waiting. Call it on unmount.
 */
export interface UndoQueue<T> {
  /** Hide now, delete later. Returns the key you would pass to `undo`. */
  schedule: (key: string, item: T) => void;
  /** Take it back. True when there was something to take back. */
  undo: (key: string) => boolean;
  /** Commit everything outstanding now — on unmount, or before a reload. */
  flush: () => Promise<void>;
  /** Keys currently hidden but not yet deleted. */
  pending: () => string[];
  /** The item behind a pending key, for the "Removed X" line. */
  peek: (key: string) => T | undefined;
}

export const UNDO_WINDOW_MS = 7000;

export function createUndoQueue<T>(opts: {
  /** Actually delete it. Rejections are reported, never thrown at the caller. */
  commit: (key: string, item: T) => Promise<unknown>;
  /** Something changed — re-render. */
  onChange: () => void;
  /** Reported rather than swallowed: a delete that failed after the row has
   *  already gone is the one case the reader cannot see for themselves. */
  onError?: (key: string, item: T, err: unknown) => void;
  delayMs?: number;
  setTimer?: (fn: () => void, ms: number) => number;
  clearTimer?: (id: number) => void;
}): UndoQueue<T> {
  const delay = opts.delayMs ?? UNDO_WINDOW_MS;
  const setTimer = opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms) as unknown as number);
  const clearTimer = opts.clearTimer ?? ((id) => clearTimeout(id));
  const waiting = new Map<string, { item: T; timer: number }>();

  const commitOne = async (key: string) => {
    const entry = waiting.get(key);
    if (!entry) return;
    waiting.delete(key);
    clearTimer(entry.timer);
    opts.onChange();
    try {
      await opts.commit(key, entry.item);
    } catch (err) {
      opts.onError?.(key, entry.item, err);
    }
  };

  return {
    schedule(key, item) {
      // Scheduling the same key twice keeps the first item and restarts the
      // clock rather than queueing two deletes of one thing.
      const existing = waiting.get(key);
      if (existing) clearTimer(existing.timer);
      waiting.set(key, {
        item: existing?.item ?? item,
        timer: setTimer(() => void commitOne(key), delay),
      });
      opts.onChange();
    },
    undo(key) {
      const entry = waiting.get(key);
      if (!entry) return false;
      clearTimer(entry.timer);
      waiting.delete(key);
      opts.onChange();
      return true;
    },
    async flush() {
      await Promise.all([...waiting.keys()].map((key) => commitOne(key)));
    },
    pending: () => [...waiting.keys()],
    peek: (key) => waiting.get(key)?.item,
  };
}
