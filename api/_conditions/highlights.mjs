/**
 * "What do these conditions actually change?"
 *
 * A grant is not a green light for what was drawn. The operative constraints —
 * a narrower entrance, a window that must be obscured, a dormer dropped below
 * the ridge, a third of the front garden kept as grass — are buried in a list
 * that is mostly the same on every permission. This picks out the ones that
 * bind.
 *
 * Measured on 236 granted applications (1,133 conditions) across Dublin City,
 * Fingal, DLR and South Dublin, harvested 2026-08-05:
 *
 *   96%  build in accordance with the lodged plans
 *   77%  surface water / SuDS / soakaway
 *   63%  Uisce Éireann connection or compliance
 *   60%  use as a single dwelling unit
 *   40%  development contribution
 *   38%  external finishes to harmonise
 *   33%  construction hours
 *   21%  spillage / wheel wash
 *
 * Clustering what those themes missed surfaced four more that recur across
 * councils and are also told to the model: dust suppression during
 * construction, "this permission relates only to the statutory public
 * notices", finishes "as shown on the submitted drawings", and the generic
 * harmonise-with-the-existing wording. Between them the skip list accounts for
 * 66% of conditions; the 388 that remain are judged on their substance.
 *
 * 59% of all conditions matched one of the first eight themes — but 26% of
 * those *also* carried a specific, checkable requirement. That is the finding
 * that shapes this: the council's grass rule lives inside a surface-water
 * condition, so dropping stock-looking conditions wholesale would throw away
 * roughly one in four of the very things worth reading. Nothing is filtered
 * out before the model sees it; the stock themes are told to it as guidance
 * for what to stay quiet about, not used as a delete list.
 *
 * Deliberately NOT on the skip list, though they recur: obscure-glazing
 * requirements, "Amendments" conditions that change the design outright, and
 * limits on attic floorspace or roof-level plant. Those are common precisely
 * because they are the constraints people keep running into.
 */

export const HIGHLIGHTS_PROMPT =
  "You read the conditions attached to an Irish planning permission and pull out only the ones " +
  "that change or limit what can actually be built, so a reader sees at a glance where the " +
  "permission differs from what was applied for.\n\n" +
  "Almost every permission repeats the same stock conditions. Say nothing about a condition that " +
  "adds nothing beyond the standard form, namely: build in accordance with the lodged plans; " +
  "finishes to be as shown on the submitted drawings, or to harmonise or match the existing " +
  "building, where no particular material or colour is named; general surface-water, SuDS or " +
  "soakaway design; connection to or compliance with Uisce Éireann; the standard bar on " +
  "sub-dividing a dwelling; construction hours; keeping mud and spillage off the road; dust " +
  "suppression during construction; the note that the permission relates only to what was in the " +
  "statutory public notices; site notices, estate naming, bonds, taking in charge, archaeological " +
  "monitoring, generic waste-management or construction-traffic plans; and boilerplate about " +
  "services being laid underground.\n\n" +
  "CRUCIAL: a stock-looking condition often hides a specific requirement. If a condition of any " +
  "kind states a dimension, a height, a width, a count, a material, a colour or a proportion, or " +
  "requires something to be omitted, reduced, relocated, screened, retained or obscured, then " +
  "that requirement is notable and you must pull it out even though the condition around it is " +
  "routine. Quote the actual figure or material.\n\n" +
  "Notable also covers: permission granted for less than was applied for; a window that must be " +
  "obscured or removed; restrictions on use, occupancy or opening hours beyond the standard " +
  "form; anything that must be submitted to and agreed with the council before work starts where " +
  "the outcome could change the design; and a permission that expires unusually early.\n\n" +
  "DEVELOPMENT CONTRIBUTIONS: say nothing at all about money the developer must pay. The total " +
  "is added separately and exactly; a point about it here would duplicate that.\n\n" +
  'Return JSON and nothing else: {"highlights":[{"n":<the condition number>,"point":"<one plain sentence>"}]}\n' +
  "Each point: under 25 words, everyday language, no policy or plan citations, no condition " +
  "jargon, state the constraint itself.\n" +
  "ORDER: what physically changes the building first (size, position, materials, openings, " +
  "boundaries, access), then limits on how it may be used, then anything to be agreed before " +
  "work starts. At most 5. If genuinely nothing is notable, return " +
  '{"highlights":[]}.';

/**
 * The development contribution, totalled in code rather than by the model.
 *
 * Councils split it across several conditions — surface water, transport,
 * community facilities — and asking for one combined figure produced either
 * three money lines crowding out the design constraints, or nothing at all:
 * a summed total appears in no single condition, so `isGrounded` correctly
 * rejected it as invented. Arithmetic is the one thing here that should never
 * be approximate, so it is done exactly and the model is told to stay quiet
 * about money.
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

export function developmentContribution(items) {
  let total = 0;
  let first = null;
  items.forEach((c, i) => {
    const amounts = payableAmounts(c.text);
    if (!amounts.length) return;
    for (const a of amounts) total += a;
    if (first === null) first = conditionNumber(c, i);
  });
  if (!total || first === null) return null;
  return { total, condition: first };
}

function contributionPoint(items) {
  const c = developmentContribution(items);
  if (!c) return null;
  const money = c.total.toLocaleString("en-IE", {
    style: "currency",
    currency: "EUR",
    minimumFractionDigits: c.total % 1 === 0 ? 0 : 2,
  });
  return {
    n: c.condition,
    point: `${money} in development contributions is payable before work starts.`,
  };
}

/** Conditions the council actually imposed — code "C". */
export function conditionItems(items) {
  return (items ?? []).filter((i) => i?.code === "C" && String(i.text ?? "").trim());
}

/** The number shown beside a condition in the UI, so a highlight can cite it. */
export function conditionNumber(item, index) {
  return item?.order || index + 1;
}

/** Cap chosen from the corpus: p99 is ~23k chars, so this truncates almost
 *  nothing while bounding a pathological 41k-char scheme. */
const MAX_CHARS = 24000;

export function conditionsUserMsg(items) {
  return items
    .map((c, i) => `--- Condition ${conditionNumber(c, i)} ---\n${c.text}`)
    .join("\n\n")
    .slice(0, MAX_CHARS);
}

/**
 * Every figure a highlight quotes must appear in the condition it cites.
 *
 * A wrong number here is worse than no highlight at all — someone could design
 * to a 3.5 m entrance the council never allowed. Compared digit-wise and
 * comma-insensitively, so "€4,328.38" in the order backs "€4,328" in the
 * point, and a year or a count has to be real too.
 */
export function isGrounded(point, conditionText) {
  const strip = (s) => String(s).replace(/,/g, "");
  const hay = strip(conditionText);
  const figures = strip(point).match(/\d+(?:\.\d+)?/g) ?? [];
  return figures.every((f) => hay.includes(f));
}

/**
 * Tolerant parse of the model's reply, then hard validation. The model is
 * asked for bare JSON but sometimes fences it or adds a line of prose.
 */
export function parseHighlights(raw, items) {
  if (!raw) return null;
  const match = String(raw).match(/\{[\s\S]*\}/);
  if (!match) return null;
  let data;
  try {
    data = JSON.parse(match[0]);
  } catch {
    return null;
  }
  if (!Array.isArray(data?.highlights)) return null;

  const byNumber = new Map(items.map((c, i) => [conditionNumber(c, i), c]));
  const seen = new Set();
  const out = [];
  for (const h of data.highlights) {
    const n = Number(h?.n);
    const point = String(h?.point ?? "").trim();
    if (!point || point.length < 5 || point.length > 300) continue;
    // A number the decision does not have means an invented condition.
    const cond = byNumber.get(n);
    if (!cond || seen.has(n)) continue;
    if (!isGrounded(point, cond.text)) continue;
    seen.add(n);
    out.push({ n, point });
    if (out.length === 6) break;
  }
  return out;
}

/**
 * Highlights for one decision. `callClaude(system, content, maxTokens,
 * timeoutMs)` is injected so the serverless entry and the dev server each pass
 * their own. Returns null when there is nothing to read or the model call
 * failed — which the UI must show differently from "nothing notable" (an empty
 * array), since one is a gap and the other is a real answer.
 */
export async function conditionHighlights(items, callClaude) {
  const conds = conditionItems(items);
  if (!conds.length) return null;
  const raw = await callClaude(HIGHLIGHTS_PROMPT, conditionsUserMsg(conds), 900, 30000);
  const points = parseHighlights(raw, conds);
  if (!points) return null;
  // Money last, and only once: what you must pay matters, but never at the
  // cost of a slot that could hold a constraint on what you can build.
  const money = contributionPoint(conds);
  return money ? [...points.filter((p) => p.n !== money.n), money] : points;
}
