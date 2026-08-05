/**
 * Precomputed plain-English summaries of application descriptions.
 *
 * This was the highest-volume model call in the app by a wide margin: nothing
 * was precomputed (0 of 132,162 rows carried one), so `!d.ai_summary` was
 * always true and every detail view of every application re-summarised from
 * scratch. Now it is generated once, in bulk, and baked into the bundle.
 *
 * Keyed by a hash of the description rather than by application, for three
 * reasons: 122,166 of 132,161 descriptions are distinct, so identical wording
 * across councils shares one summary; bundle ids are positional and shift on
 * every rebuild; and when the nightly agile harvest replaces a truncated
 * description with the council's full text, the hash changes and the summary
 * is correctly regenerated instead of describing the old text.
 */
import { createHash } from "node:crypto";

/**
 * Whitespace-insensitive so a reflowed copy of the same wording reuses the
 * summary, but otherwise exact — a description that differs in substance must
 * get its own.
 */
export function descriptionKey(description) {
  const norm = String(description ?? "").replace(/\s+/g, " ").trim();
  if (!norm) return null;
  return createHash("sha256").update(norm).digest("hex").slice(0, 24);
}

export const DESCRIPTION_SUMMARY_PROMPT =
  "You summarise Irish planning applications in one short sentence of plain English. " +
  "The reader is a regular person, not a planner or architect. " +
  "Say what the project actually is: an extension, a new house, a commercial unit, solar panels, etc. " +
  "Include key details like number of bedrooms or storeys only when stated. " +
  'Never start with "This application is for". Just state what it is. ' +
  "Keep it under 30 words. " +
  "Output only the summary itself — never address the reader, never ask a question, never mention " +
  "that information is missing or incomplete, never refer to yourself. If the material does not " +
  "contain enough to write the summary, reply with exactly this single word and nothing else: INSUFFICIENT";

export function descriptionUserMsg(description, applicationType) {
  return applicationType
    ? `Application type: ${applicationType}\nDescription: ${description}`
    : String(description);
}
