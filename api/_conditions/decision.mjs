/**
 * Is the "decision" on a planning record actually a decision?
 *
 * Often it is not. Councils use the decision column as a running log of the
 * last thing that happened to the file, so an application still under
 * assessment carries a decision of "N/A", "Request Additional Information" or
 * "Seek Clarification of Additional Information". Rendered as written, the
 * sheet told people an undecided application had been decided, and offered to
 * summarise a decision that does not exist.
 *
 * Measured across the live register (samples of 200 per status, 2026-08-18):
 *
 *   736  "N/A"                                     Meath, Kildare, Wicklow
 *   224  "Request Additional Information"          South Dublin
 *   133  "REQUEST ADDITIONAL INFORMATION"          Fingal, DLR
 *   124  "ADDITIONAL INFORMATION"                  Dublin City
 *    22  "REQUEST AI EXT OF TIME"                  Dublin City
 *    17  "S5 REQ AI"                               DLR
 *    16  "Seek Clarification of Additional Info…"  South Dublin
 *
 * Two thirds of applications sitting at the further-information stage carried
 * one of these in the decision field, and 120 of a 200-row sample of "pending"
 * did too.
 *
 * Deliberately NOT treated as a stage, though they also fail to name a grant
 * or a refusal: "Decision Quashed", "Annulled", "Cannot Determine",
 * "Precluded under 34(12)(b) from Making a Decision", "Returned Application
 * under Section 37(5)", "Decision to be Made by Other Body". Those are real
 * outcomes, however unusual, and blanking them would delete the only record of
 * what happened. The rule below is a positive list of procedural steps, not
 * "anything we failed to classify".
 */

/**
 * Any word that names a real outcome. Checked first, so a decision that says
 * both — "Grant permission following receipt of additional information" — is
 * read as the grant it is.
 */
const NAMES_AN_OUTCOME =
  /grant|approv|conditional|unconditional|refus|reject|withdraw|invalid|declar|exempt|split|quash|annul|cannot determine|precluded|returned application|other body|referred to/i;

/** Placeholders councils write when there is nothing to record yet. */
const PLACEHOLDER = /^(n\s*\/?\s*a|none|nil|null|tbc|tbd|no fee|-+|\.+)$/i;

/**
 * The council has asked the applicant for more. This is the one stage worth
 * naming rather than merely hiding: it is where the application actually is,
 * and what was asked for is on the file.
 */
const INFO_REQUEST =
  /\b(additional|further)\s+information\b|\bfurther particulars\b|\breq(uest)?\s*a\.?i\.?\b|\bai\s+(request|ext)\b|\bclarification\b/i;

/** Other housekeeping steps that are not outcomes either. */
const OTHER_PROCEDURAL =
  /\b(revised|new)\s+(public|newspaper|site)\s+notice\b|\brevised drawings\b|\bextension of time\b|\brequest time extension\b|\bpublication required\b/i;

/**
 * What the decision field is really recording.
 *
 * Returns "further_info" when it is a request for more information,
 * "procedural" for any other non-outcome step, "placeholder" for an empty
 * marker, and null when it names a genuine outcome (or is blank).
 */
export function decisionStage(decision) {
  const dec = String(decision ?? "").trim();
  if (!dec) return null;
  if (NAMES_AN_OUTCOME.test(dec)) return null;
  if (PLACEHOLDER.test(dec)) return "placeholder";
  if (INFO_REQUEST.test(dec)) return "further_info";
  if (OTHER_PROCEDURAL.test(dec)) return "procedural";
  return null;
}

/** The decision text, or null when the field holds a stage instead. */
export function realDecision(decision) {
  return decisionStage(decision) === null ? (decision ?? null) : null;
}

/** The council has asked for more information and is waiting on the answer. */
export function isFurtherInfoRequest(decision) {
  return decisionStage(decision) === "further_info";
}
