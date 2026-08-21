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
  "A clock time is not one of those figures. The hours during which building work may be carried " +
  "out are on a third of all permissions in the same standard form, and listing them tells the " +
  "reader nothing about how this permission differs from what was applied for. Never report the " +
  "working hours, whatever times they name and however precisely, and whether the condition " +
  "calls them site hours, working hours, construction hours or hours of operation during " +
  "construction.\n\n" +
  "That does not make every approval notable. Drainage, surface-water and SuDS conditions almost " +
  "always require details to be submitted and agreed before work starts — that is the standard " +
  "form, not a constraint on the design, so say nothing about them unless the condition itself " +
  "names a figure, a material or something that must be moved or left out.\n\n" +
  "Notable also covers: permission granted for less than was applied for; a window that must be " +
  "obscured or removed; restrictions on use or occupancy beyond the standard form; limits on the " +
  "hours the FINISHED development may operate — a shop's or a creche's opening hours, which bind " +
  "whoever lives with it afterwards, and which are not the same thing as the hours the builders " +
  "may work; anything that must be submitted to and agreed with the council before work starts " +
  "where the outcome could change the design; and a permission that expires unusually early.\n\n" +
  "DEVELOPMENT CONTRIBUTIONS: say nothing at all about money the developer must pay. The total " +
  "is stated separately and exactly, above this list; a point about it here would duplicate " +
  "that.\n\n" +
  'Return JSON and nothing else: {"highlights":[{"n":<the condition number>,"point":"<one plain sentence>"}]}\n' +
  "Each point: under 25 words, everyday language, no policy or plan citations, no condition " +
  "jargon, state the constraint itself.\n" +
  "ORDER: what physically changes the building first (size, position, materials, openings, " +
  "boundaries, access), then limits on how it may be used, then anything to be agreed before " +
  "work starts. At most 5. If genuinely nothing is notable, return " +
  '{"highlights":[]}.';

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
/**
 * Working hours are never notable, whatever the model decides.
 *
 * The prompt has always listed them among the stock conditions to stay quiet
 * about, and two later instructions overrode it: the rule that a condition
 * naming a figure must be pulled out even when the condition around it is
 * routine — and a working-hours condition is nothing but figures — and
 * "restrictions on … opening hours", which means the hours a finished shop or
 * creche may operate and reads close enough to catch this. Dublin City
 * 2893/21 surfaced "Site works only Monday–Friday 7am–6pm" as one of three
 * notable conditions on a twelve-condition grant.
 *
 * Both instructions are now narrowed, and this is the backstop: the same shape
 * as contradictsOutcome on an appeal summary, because a wrong highlight is
 * seen by everyone who opens the page and a prompt is not a guarantee.
 *
 * Matched on the point the model wrote rather than on the condition text: a
 * condition can mention working hours in passing while its substance is
 * something else entirely, and it is what we would print that has to be wrong.
 */
/** Words for the act of building, as the model tends to phrase it. */
const WORK_ACTIVITY_RE =
  /\b(?:site\s+works?|building\s+works?|construction|demolition|works?\s+on\s+site|work(?:ing)?\s+hours?|site\s+hours?|hours?\s+of\s+work(?:ing)?)\b/i;
/** A clock time in any of the shapes a council writes one. */
const CLOCK_RE = /\b\d{1,2}(?::\d{2})?\s*(?:a\.?m\.?|p\.?m\.?)\b|\b\d{1,2}:\d{2}\b/i;
const HOURS_WORD_RE = /\bhours?\b/i;
/** The hours a finished development may operate are a real restriction on
 *  whoever lives beside it — never confuse the two. */
const OPERATING_HOURS_RE =
  /\b(?:open(?:ing)?|trading|business|operating|delivery|deliveries|customers?)\b[^.]{0,40}\bhours?\b/i;

export function isWorkingHours(point) {
  const t = String(point ?? "");
  if (OPERATING_HOURS_RE.test(t)) return false;
  if (!WORK_ACTIVITY_RE.test(t)) return false;
  // The activity alone is not enough — "a construction traffic management plan"
  // is about something else. It has to be about when.
  return HOURS_WORD_RE.test(t) || CLOCK_RE.test(t);
}

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
    if (isWorkingHours(point)) continue;
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
  // The development contribution used to be appended here. It is on ~40% of
  // permissions and changes nothing about what can be built, so under the
  // heading "Notable conditions" it was neither; the sheet states the total as
  // a fact instead (see contribution.mjs).
  //
  // Ordered by condition number so the list reads in step with the conditions
  // underneath it — ranking by interest put 3 above 2 and made the pairing
  // hard to follow.
  return points.sort((a, b) => a.n - b.n);
}
