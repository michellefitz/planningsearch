/**
 * What the Commission actually decided.
 *
 * An appeal decision reaches us two ways, and they are not equally good.
 *
 * The council's register carries a code — CONDITIONAL, REFUSED, MODIFIED,
 * WITHDRAWN, DISMISSED — and MODIFIED is the trap. Checked against An
 * Coimisiún Pleanála's own case pages for every MODIFIED appeal on the three
 * eplanning councils: twelve of fifteen were "Grant permission with (revised)
 * conditions", two were "Contribution Appeal Decided" — a section 48 money
 * appeal that decides nothing about the permission — and one had no decision
 * published yet. So MODIFIED usually means granted and sometimes means
 * something else entirely, which is not a basis for telling a reader their
 * neighbour's house was approved.
 *
 * The Commission's case page carries the decision in its own words, and that
 * is the authority. Where we have it, it is used. Where we do not, an
 * ambiguous code produces no claim at all — the sheet says the appeal was
 * decided, gives the date, and links to the case file.
 */

const REFUSED = /\brefus|\breject/i;
const GRANTED = /\bgrant|\bconditional\b|\bpermission granted\b/i;
const WITHDRAWN = /\bwithdraw/i;
const DISMISSED = /\bdismiss/i;
const INVALID = /\binvalid\b/i;
/** Section 48 contribution appeals decide the money, not the permission. */
const CONTRIBUTION = /\bcontribution\b/i;
/** Coarse council codes that name a change without naming an outcome. */
const AMBIGUOUS = /^\s*(modified|amended|varied|altered)\s*$/i;

/**
 * `raw` is the Commission's own wording where we have it, the council's code
 * otherwise. Returns `kind: null` when nothing can be said honestly.
 */
export function appealOutcome(raw) {
  const text = String(raw ?? "").trim();
  if (!text) return { kind: null, label: null, conditional: false };
  if (AMBIGUOUS.test(text)) return { kind: null, label: null, conditional: false };
  if (CONTRIBUTION.test(text))
    return { kind: "other", label: "Contribution appeal decided", conditional: false };
  if (WITHDRAWN.test(text)) return { kind: "withdrawn", label: "Appeal withdrawn", conditional: false };
  if (INVALID.test(text)) return { kind: "invalid", label: "Appeal invalid", conditional: false };
  // Dismissal leaves the council's decision standing, which is the thing worth
  // saying — "dismissed" alone reads as though nothing happened.
  if (DISMISSED.test(text))
    return { kind: "dismissed", label: "Appeal dismissed — the council's decision stands", conditional: false };
  if (REFUSED.test(text)) return { kind: "refused", label: "Refused", conditional: false };
  if (GRANTED.test(text)) {
    // "Grant permission with revised conditions" and "Grant Permissions with
    // Conditions" are both grants that carry a schedule worth reading.
    const conditional = /\bcondition/i.test(text) || /\bconditional\b/i.test(text);
    return {
      kind: "granted",
      label: conditional ? "Granted with conditions" : "Granted",
      conditional,
    };
  }
  return { kind: null, label: null, conditional: false };
}

/** The Commission's word where the case page gave us one, the register's otherwise. */
export function bestAppealDecision(caseFields, registerDecision) {
  const field = (caseFields ?? []).find((f) => /^decision$/i.test(String(f?.label ?? "").trim()));
  const fromCase = field?.value ? String(field.value).trim() : null;
  if (fromCase && appealOutcome(fromCase).kind) return fromCase;
  return fromCase ?? registerDecision ?? null;
}

/**
 * Does a summary say the opposite of what was decided?
 *
 * The check that would have caught case 322612, where a summary written from
 * the inspector's report announced that "the refusal should stand" directly
 * above a decision line reading granted. Only the two outcomes that can
 * contradict each other are tested, and only on wording specific enough to be
 * sure — a summary that mentions the council's refusal in passing is not
 * claiming the appeal failed.
 */
const SAYS_REFUSAL_STOOD =
  /refusal (?:should |was |is )?(?:stand|stands|stood|upheld|affirmed)|upheld the (?:council'?s )?refusal|(?:dismissed|rejected) the appeal|refused permission on appeal|appeal (?:was )?(?:unsuccessful|dismissed|refused)/i;
const SAYS_GRANTED =
  /granted permission|permission (?:was |is )?granted|overturned the (?:council'?s )?refusal|allowed the appeal|appeal (?:was )?(?:successful|allowed)/i;

export function contradictsOutcome(summary, outcomeKind) {
  const text = String(summary ?? "");
  if (!text || !outcomeKind) return false;
  if (outcomeKind === "granted") return SAYS_REFUSAL_STOOD.test(text);
  if (outcomeKind === "refused") return SAYS_GRANTED.test(text);
  return false;
}
