import { useEffect, useState } from "react";

/**
 * Waiting with nothing to read is indistinguishable from broken.
 *
 * Three reviewers independently reported the same thing about three different
 * parts of the app: the file list "never loads", Dublin City's conditions
 * "don't come", Ask "died". None of that was true — a council portal was
 * taking twenty seconds, a scanned decision order was being read, a model was
 * answering. The work was fine; the silence was the defect.
 *
 * So a wait says what it is waiting for, and keeps saying it in changing
 * words. A message that has visibly moved on is the difference between
 * something working slowly and something that has stopped — a spinner alone
 * cannot tell the two apart, which is why people close the sheet at fifteen
 * seconds and report it as broken.
 */

/** Whole seconds since `active` last became true. 0 whenever it is false. */
export function useElapsed(active: boolean): number {
  const [seconds, setSeconds] = useState(0);
  useEffect(() => {
    if (!active) {
      setSeconds(0);
      return;
    }
    setSeconds(0);
    const started = Date.now();
    const timer = window.setInterval(
      () => setSeconds(Math.floor((Date.now() - started) / 1000)),
      1000
    );
    return () => window.clearInterval(timer);
  }, [active]);
  return seconds;
}

/** What to say, and how many seconds of waiting earns it. */
export type WaitStage = [afterSeconds: number, message: string];

/**
 * The last message the wait has earned. Stages are given in order, the first
 * at 0 — so there is never a silent moment before the first one lands.
 */
export function stageMessage(seconds: number, stages: WaitStage[]): string {
  let message = stages[0]?.[1] ?? "";
  for (const [after, text] of stages) if (seconds >= after) message = text;
  return message;
}

/**
 * A labelled wait. `role="status"` rather than a live region on every tick:
 * the text changes twice in half a minute, which is worth announcing, and the
 * seconds are deliberately not shown — a counter invites people to watch it.
 */
export function Waiting({
  active,
  stages,
  className = "hint loading-line",
}: {
  active: boolean;
  stages: WaitStage[];
  className?: string;
}) {
  const seconds = useElapsed(active);
  if (!active) return null;
  return (
    <p className={className} role="status">
      {stageMessage(seconds, stages)}
    </p>
  );
}
