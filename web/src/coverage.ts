import type { Meta } from "./api";

/**
 * How far back each council's register goes here.
 *
 * The national feed's depth is very uneven — Dublin City starts 2019 and
 * Kildare 2017, while South Dublin reaches 1992 — and unstated that turns an
 * empty result into a wrong answer: "no planning history exists" rather than
 * "we don't hold that year". Everything below exists to say which one it is.
 */

/** Earliest year held for one council, or null if we hold nothing for it. */
export function coverageYear(meta: Meta | null, authorityId: string): string | null {
  const a = meta?.authorities.find((x) => x.id === authorityId);
  return a?.earliest_received ? a.earliest_received.slice(0, 4) : null;
}

/** "Dublin City from 2019, Kildare from 2017, …" across everything we hold. */
export function coverageSummary(meta: Meta | null): string | null {
  const held = (meta?.authorities ?? [])
    .filter((a) => a.earliest_received && a.application_count > 0)
    .sort((a, b) => (b.earliest_received ?? "").localeCompare(a.earliest_received ?? ""));
  if (!held.length) return null;
  const parts = held.map((a) => `${a.short_name} from ${a.earliest_received!.slice(0, 4)}`);
  const list =
    parts.length > 1 ? `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}` : parts[0];
  return `Coverage runs ${list}. Applications older than that aren't in the register we search.`;
}

/** Scoped to one council, for a page that is already about one property. */
export function coverageNoteFor(meta: Meta | null, authorityId: string): string | null {
  const year = coverageYear(meta, authorityId);
  if (!year) return null;
  const a = meta?.authorities.find((x) => x.id === authorityId);
  return `We hold ${a?.short_name ?? "this council"}'s register from ${year} — anything earlier won't appear here.`;
}
