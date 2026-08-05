/**
 * Nightly top-up of the precomputed description summaries.
 *
 * The bulk backfill (scripts/summaries/backfill.mjs) covers the register as it
 * stood; this keeps up with the ~400–500 applications a day that arrive after
 * it. Runs inside /api/cron/refresh-data, before the deploy hook fires, so the
 * rebuild that follows bakes the new summaries into the bundle.
 *
 * Without this the feature would decay: every application added since the last
 * backfill would fall through to the live per-view model call the precompute
 * exists to remove, and the gap would widen every day.
 */
import { sql } from "../_accounts/db.mjs";
import { DESCRIPTION_SUMMARY_PROMPT, descriptionKey, descriptionUserMsg } from "./descriptions.mjs";

const MODEL = "claude-haiku-4-5-20251001";
const CONCURRENCY = 8;
/** Well inside the cron's 300 s budget, which the agile harvest also draws on. */
const TIME_BUDGET_MS = 60_000;
/** A night's intake is a few hundred; a far larger number means the backfill
 *  never ran, and that is a job for the script, not for a cron window. */
const MAX_PER_RUN = 1500;

const LEAK_RE =
  /\b(?:I (?:don'?t|do not|cannot|can'?t|couldn'?t|am unable|'?m unable|'?m sorry)|as an AI|could you (?:provide|clarify|share)|please provide|not enough (?:info|information|detail)|appears? (?:incomplete|to be incomplete)|the (?:description|text) (?:appears|seems|is) |would you like|unable to (?:summari|determine|tell))/i;

function usable(text) {
  if (!text) return null;
  const t = String(text).trim();
  if (!t || /^insufficient[.!]?$/i.test(t) || LEAK_RE.test(t)) return null;
  return t;
}

async function summarise(description, applicationType, apiKey) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20_000);
  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      signal: controller.signal,
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 120,
        system: DESCRIPTION_SUMMARY_PROMPT,
        messages: [{ role: "user", content: descriptionUserMsg(description, applicationType) }],
      }),
    });
    if (!res.ok) return null;
    const data = await res.json();
    return usable(data.content?.find((b) => b.type === "text")?.text ?? null);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Summarise the descriptions in `applications` that have no stored summary.
 * Returns counts for the cron's response. Never throws — a failed top-up costs
 * a day of freshness, not the nightly rebuild.
 */
export async function topUpDescriptionSummaries(applications) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey || !process.env.DATABASE_URL) {
    return { skipped: !apiKey ? "ANTHROPIC_API_KEY not set" : "DATABASE_URL not set" };
  }
  const started = Date.now();
  try {
    await sql(`create table if not exists description_summaries (
      description_hash text primary key,
      summary text not null,
      model text not null,
      created_at timestamptz not null default now()
    )`);

    const wanted = new Map();
    for (const a of applications) {
      const key = descriptionKey(a.description);
      if (!key || wanted.has(key)) continue;
      wanted.set(key, { description: a.description, applicationType: a.application_type ?? null });
    }
    const stored = new Set(
      (await sql(`select description_hash from description_summaries`)).map(
        (r) => r.description_hash
      )
    );
    const queue = [...wanted.entries()].filter(([k]) => !stored.has(k)).slice(0, MAX_PER_RUN);
    const outstanding = wanted.size - stored.size;
    if (!queue.length) return { generated: 0, outstanding: Math.max(outstanding, 0) };

    const rows = [];
    let timedOut = false;
    async function worker() {
      while (queue.length) {
        if (Date.now() - started > TIME_BUDGET_MS) {
          timedOut = true;
          return;
        }
        const [hash, { description, applicationType }] = queue.shift();
        const summary = await summarise(description, applicationType, apiKey);
        if (summary) rows.push([hash, summary]);
      }
    }
    await Promise.all(Array.from({ length: CONCURRENCY }, worker));

    for (let i = 0; i < rows.length; i += 200) {
      const batch = rows.slice(i, i + 200);
      const values = batch.map((_, j) => `($${j * 3 + 1}, $${j * 3 + 2}, $${j * 3 + 3})`).join(",");
      await sql(
        `insert into description_summaries (description_hash, summary, model) values ${values} ` +
          `on conflict (description_hash) do nothing`,
        batch.flatMap(([h, s]) => [h, s, MODEL])
      );
    }
    return {
      generated: rows.length,
      // What is still missing after this run — a number that keeps growing
      // means the budget is too small or the backfill was never completed.
      outstanding: Math.max(outstanding - rows.length, 0),
      timed_out: timedOut || undefined,
      ms: Date.now() - started,
    };
  } catch (err) {
    return { error: String(err?.message ?? err) };
  }
}
