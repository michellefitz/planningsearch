import { describe, expect, it, vi } from "vitest";
import { createUndoQueue } from "../../web/src/undoQueue.js";

/**
 * Unsaving an application was a bare X that deleted immediately, with no
 * confirmation and no way back — and on a phone it sat at full weight on every
 * row beside a list dropdown, indistinguishable from a dismiss.
 *
 * A confirm dialog would fix the accident and cost everyone else a click. This
 * does the opposite: the row goes at once and the delete does not happen until
 * the window lapses, so taking it back restores the save exactly as it was —
 * alerts setting, list membership, history — because nothing was deleted.
 */
function harness(over: Record<string, unknown> = {}) {
  const timers = new Map<number, () => void>();
  let nextId = 1;
  const commit = vi.fn(async () => {});
  const onChange = vi.fn();
  const q = createUndoQueue<{ ref: string }>({
    commit,
    onChange,
    delayMs: 1000,
    setTimer: (fn) => {
      const id = nextId++;
      timers.set(id, fn);
      return id;
    },
    clearTimer: (id) => timers.delete(id),
    ...over,
  });
  return { q, commit, onChange, fire: () => [...timers.values()].forEach((fn) => fn()), timers };
}

describe("createUndoQueue", () => {
  it("does not delete anything while the window is open", () => {
    const { q, commit } = harness();
    q.schedule("a", { ref: "26/1" });
    expect(commit).not.toHaveBeenCalled();
    expect(q.pending()).toEqual(["a"]);
  });

  it("deletes once the window lapses", async () => {
    const { q, commit, fire } = harness();
    q.schedule("a", { ref: "26/1" });
    fire();
    await Promise.resolve();
    expect(commit).toHaveBeenCalledWith("a", { ref: "26/1" });
    expect(q.pending()).toEqual([]);
  });

  it("undo means nothing was ever deleted", async () => {
    const { q, commit, fire } = harness();
    q.schedule("a", { ref: "26/1" });
    expect(q.undo("a")).toBe(true);
    fire();
    await Promise.resolve();
    expect(commit).not.toHaveBeenCalled();
    expect(q.pending()).toEqual([]);
  });

  it("says when there was nothing to take back", () => {
    const { q } = harness();
    expect(q.undo("never-scheduled")).toBe(false);
  });

  it("commits what is still waiting when the panel closes", async () => {
    const { q, commit } = harness();
    q.schedule("a", { ref: "26/1" });
    q.schedule("b", { ref: "26/2" });
    await q.flush();
    expect(commit).toHaveBeenCalledTimes(2);
    expect(q.pending()).toEqual([]);
  });

  it("flushing after an undo commits only what is left", async () => {
    const { q, commit } = harness();
    q.schedule("a", { ref: "26/1" });
    q.schedule("b", { ref: "26/2" });
    q.undo("a");
    await q.flush();
    expect(commit).toHaveBeenCalledTimes(1);
    expect(commit).toHaveBeenCalledWith("b", { ref: "26/2" });
  });

  it("never queues two deletes of one thing", async () => {
    const { q, commit, fire } = harness();
    q.schedule("a", { ref: "26/1" });
    q.schedule("a", { ref: "26/1" });
    fire();
    await Promise.resolve();
    expect(commit).toHaveBeenCalledTimes(1);
  });

  it("keeps the original item when the same key is scheduled twice", () => {
    const { q } = harness();
    q.schedule("a", { ref: "first" });
    q.schedule("a", { ref: "second" });
    expect(q.peek("a")).toEqual({ ref: "first" });
  });

  it("reports a failed delete rather than swallowing it", async () => {
    // The row has already gone, so this is the one failure the reader cannot
    // see for themselves.
    const onError = vi.fn();
    const { q, fire } = harness({
      commit: async () => {
        throw new Error("network");
      },
      onError,
    });
    q.schedule("a", { ref: "26/1" });
    fire();
    await Promise.resolve();
    await Promise.resolve();
    expect(onError).toHaveBeenCalled();
  });

  it("re-renders on every state change", () => {
    const { q, onChange } = harness();
    q.schedule("a", { ref: "26/1" });
    expect(onChange).toHaveBeenCalledTimes(1);
    q.undo("a");
    expect(onChange).toHaveBeenCalledTimes(2);
  });
});
