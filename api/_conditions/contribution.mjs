/**
 * The development contribution, totalled in code rather than by a model.
 *
 * Councils split it across several conditions — surface water, transport,
 * community facilities — and asking the model for one combined figure produced
 * either three money lines crowding out the design constraints, or nothing at
 * all: a summed total appears in no single condition, so the grounding check
 * correctly rejected it as invented. Arithmetic is the one thing here that
 * should never be approximate, so it is done exactly and the model is told to
 * stay quiet about money.
 *
 * It used to be appended to the "notable conditions" list. It is on ~40% of
 * permissions and changes nothing about what can be built, so it was never
 * notable — it is a fact about the decision, and the sheet now states it as
 * one. Kept in its own module so the web bundle can total it from the
 * conditions it already holds without pulling in the model prompt.
 */

/**
 * Matched at clause level, not condition level. Some DLR records arrive with
 * every condition concatenated into a single item, so one "condition" can
 * carry three separate contribution clauses — surface water, transport,
 * community — and taking one figure per condition charged €4.97 for a bill of
 * €497.15. The € must follow the phrase directly, so a passing reference to
 * the Development Contribution Scheme contributes nothing.
 */
const CONTRIBUTION_RE =
  /(?:sum of|contribution of)\s*€\s?(\d{1,3}(?:,\d{3})*(?:\.\d{2})?|\d+(?:\.\d{2})?)/gi;
/**
 * South Dublin appends amendments to the original condition rather than
 * replacing it ("Condition 18 was amended by PR/0805/26 on 17/07/2026: …"),
 * so a condition can carry both the superseded figure and the current one.
 * Real case: SD26A/0084W reads €222,068.16 then €88,325.28 — charging the
 * first would overstate the bill by €133,742.88.
 */
const AMENDED_RE = /\bamended by\b[^:]{0,160}:/gi;

/** Everything payable under one condition, after any amendment. */
export function payableAmounts(text) {
  const src = String(text);
  const marks = [...src.matchAll(AMENDED_RE)];
  // An amendment restates the whole condition, so only the text after the
  // last marker still applies.
  const scope = marks.length
    ? src.slice(marks.at(-1).index + marks.at(-1)[0].length)
    : src;
  const out = [];
  for (const m of scope.matchAll(CONTRIBUTION_RE)) {
    const amount = Number(m[1].replace(/,/g, ""));
    if (Number.isFinite(amount) && amount > 0) out.push(amount);
  }
  return out;
}

/** The number shown beside a condition in the UI, so a total can cite it. */
function conditionNumber(item, index) {
  return item?.order || index + 1;
}

export function developmentContribution(items) {
  // Conditions only. A note or a reason can mention a sum without anyone
  // owing it, and the fallback numbering must count within the conditions
  // list so a cited number matches what the sheet shows.
  const conds = (items ?? []).filter((i) => i?.code === "C");
  let total = 0;
  let first = null;
  conds.forEach((c, i) => {
    const amounts = payableAmounts(c.text);
    if (!amounts.length) return;
    for (const a of amounts) total += a;
    if (first === null) first = conditionNumber(c, i);
  });
  if (!total || first === null) return null;
  return { total, condition: first };
}
