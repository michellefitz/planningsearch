/**
 * A headline for every condition.
 *
 * What the councils put in the title field is not comparable between them.
 * South Dublin writes a real label — "Construction hours", "Domestic Extension
 * (Water Services)" — and needs no help. Dún Laoghaire-Rathdown writes its
 * internal code, so a permission rendered as a column of C1, C2, C3, C4 with
 * an FS on top. Fingal and Dublin City paste the opening of the wording, cut
 * at about seventy characters, so the collapsed row was the condition broken
 * mid-word and opening it showed the same sentence again.
 *
 * labels.mjs recovers what it can without asking anybody: it recognises the
 * codes and the echoes, matches the wording against planning themes, and falls
 * back to the opening words. That is enough to stop the list looking broken and
 * not enough to make it scannable — most house conditions raise no theme, and
 * "The development shall be carried out…" is a label in the same sense that a
 * truncated sentence is.
 *
 * So the ones that are still unlabelled get a real title, written from the
 * wording. It is a separate call from the highlights on purpose: that prompt
 * was tuned against 1,133 conditions to decide what is notable, and giving it
 * a second job to do is a good way to make it worse at the first.
 */

/**
 * Enough of a condition to title it.
 *
 * Conditions announce their subject in the first line and spend the rest on
 * the mechanics — "REASON: to ensure the development does not injure the
 * amenities of property in the vicinity" is on nearly all of them and titles
 * none of them.
 */
const HEAD_CHARS = 400;
/** Beyond this a decision is a schedule, and the tail of it is boilerplate. */
const MAX_ITEMS = 30;

export const TITLES_PROMPT =
  "You title the conditions attached to an Irish planning permission, so a reader can scan the " +
  "list and find the one they need without opening every row.\n\n" +
  "Return ONLY a JSON array, no prose and no Markdown fences:\n" +
  '[{"n": number, "title": string}]\n\n' +
  "n is the condition number you were given. title is what the condition controls, in AT MOST " +
  "FIVE WORDS of plain English — the words a person would use, not the council's. " +
  '"Construction hours". "Obscure glazing to side windows". "Development contribution". ' +
  '"Front garden planting". "Use as a single dwelling".\n\n' +
  "Name the subject, never the instrument: not \"Condition 4\", not \"Compliance\", not " +
  "\"Requirements\", not \"Standard condition\" — those are what the reader already knows. If a " +
  "condition changes something specific about the building, the title says which thing: " +
  '"Rooflights to rear only" beats "Rooflights". Two conditions may share a title if they really ' +
  "are about the same thing.\n\n" +
  "Title every condition you are given, once each. Use only what its wording says — never invent " +
  "a subject the condition does not raise.";

/** The conditions that still have no title worth showing. */
export function untitledItems(items, isUsable) {
  return (items ?? [])
    .filter((i) => String(i?.text ?? "").trim() && !isUsable(i))
    .slice(0, MAX_ITEMS);
}

export function titlesUserMsg(items) {
  return items
    .map((c, i) => `--- ${c.order || i + 1} ---\n${String(c.text ?? "").slice(0, HEAD_CHARS)}`)
    .join("\n\n");
}

/**
 * Five words, and no more.
 *
 * The cap is the whole point of the label — a title that runs to a line is the
 * thing this replaces — so it is enforced here rather than hoped for. Anything
 * the model returns as a sentence is cut at a word, and anything it returns as
 * the instrument rather than the subject is dropped, leaving the deterministic
 * label in place.
 */
const NOT_A_SUBJECT =
  /^(?:condition|standard|general|compliance|requirements?|miscellaneous|other|note|n\/a)\b/i;

export function cleanTitle(raw) {
  const t = String(raw ?? "")
    .replace(/[`*_#]/g, "")
    .replace(/\s+/g, " ")
    .replace(/[.:;,]+$/, "")
    .trim();
  if (!t || t.length < 3 || t.length > 60) return null;
  if (NOT_A_SUBJECT.test(t)) return null;
  const words = t.split(" ");
  const cut = words.length > 5 ? words.slice(0, 5).join(" ") : t;
  // Sentence case: the model sometimes shouts, sometimes title-cases.
  return cut.charAt(0).toUpperCase() + cut.slice(1);
}

export function parseTitles(raw, items) {
  const text = String(raw ?? "").trim();
  const start = text.indexOf("[");
  const end = text.lastIndexOf("]");
  if (start < 0 || end <= start) return [];
  let parsed;
  try {
    parsed = JSON.parse(text.slice(start, end + 1));
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const wanted = new Set(items.map((c, i) => c.order || i + 1));
  const seen = new Set();
  const out = [];
  for (const row of parsed) {
    const n = Number((row ?? {}).n);
    if (!wanted.has(n) || seen.has(n)) continue;
    const title = cleanTitle((row ?? {}).title);
    if (!title) continue;
    seen.add(n);
    out.push({ n, title });
  }
  return out;
}

/** `[{n, title}]` for the conditions that had none. Empty when the call fails. */
export async function conditionTitles(items, callClaude) {
  if (!items.length) return [];
  const raw = await callClaude(TITLES_PROMPT, titlesUserMsg(items), 700, 25000);
  return raw ? parseTitles(raw, items) : [];
}
