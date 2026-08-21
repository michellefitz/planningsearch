/**
 * Scannable labels for conditions and reasons.
 *
 * The portals often give a prescription no useful title of its own: Dublin
 * City stamps every reason on an appealed case "ACP Reason", so a refusal
 * renders as "ACP Reason 1 … 4" and a reader has to open all four to learn
 * anything. The wording itself is there, so the label is derived from it.
 *
 * Deliberately deterministic rather than a model call. The conditions list
 * paints as soon as the register responds — putting a model in front of it
 * would either delay the list or make the titles pop in late — and a wrong
 * label on a collapsed row is worse than a plain one, because it is the only
 * thing most readers will ever see. Theme matching cannot invent a subject
 * the text does not mention.
 *
 * The label is a signpost, not a summary: it says which planning issue the
 * item is about so the list can be scanned, and the full wording is one click
 * away for anyone who wants what was actually said.
 */

/**
 * Planning themes, most-specific first — the first two matches become the
 * label. Order is what makes a label accurate when several themes appear: a
 * refusal over demolition usually also cites the conservation area it sits in,
 * so `demolition` must outrank `conservation area` or the label names the
 * setting instead of the act. Each pattern is matched against the item's full
 * text, so a theme can only be named if the wording raises it.
 */
const THEMES = [
  [/\bflood(ing|ed)?\b|\bflood risk\b/i, "Flood risk"],
  [/\bdemolit|\bdemolish/i, "Demolition"],
  [/\bzon(ing|ed|e)\b|land use objective/i, "Zoning"],
  [/conservation area|protected structure|architectural (heritage|conservation)|\bACA\b/i, "Conservation area"],
  [/archaeolog/i, "Archaeology"],
  [/overlook|overbearance|overbearing|overshadow|loss of privacy|residential amenity/i, "Overlooking"],
  [/\bprecedent\b/i, "Precedent"],
  [/overdevelop|\bdensity\b|plot ratio/i, "Overdevelopment"],
  [/\bparking\b/i, "Parking"],
  [/\btraffic\b|vehicular (access|entrance)|sight ?lines?|road safety/i, "Traffic"],
  [/drainage|surface water|\bsewer|waste ?water|Uisce|Irish Water|\bSuDS\b/i, "Drainage"],
  [/open space|amenity space|recreational amenity/i, "Open space"],
  [/\bdaylight\b|\bsunlight\b/i, "Daylight"],
  [/ecolog|habitat|\bbats?\b|appropriate assessment|Natura|protected species/i, "Ecology"],
  [/\btrees?\b|hedgerow/i, "Trees"],
  [/landscap/i, "Landscaping"],
  [/construction hours|working hours|hours of (work|operation)/i, "Construction hours"],
  [/development contribution|contribution scheme/i, "Development contribution"],
  [/materials?|finishes|render|brick|cladding/i, "Materials"],
  [/\bnoise\b/i, "Noise"],
  [/\bwaste\b|refuse storage/i, "Waste"],
  [/design|scale|massing|height|bulk|streetscape/i, "Design"],
  [/\bsigns?\b|signage|advertis/i, "Signage"],
  [/\bwater supply\b|\bservices\b/i, "Services"],
];

/**
 * Titles that carry no information — the item's own words tell the reader
 * nothing the group heading and number have not already said. "ACP Reason",
 * "Reason", "Condition 3", a bare number, or an empty string.
 *
 * Also the portals' internal codes. Dún Laoghaire-Rathdown titles its
 * conditions "C1" … "C18" and its first schedule "FS", so a decision rendered
 * as a column of C1, C2, C3, C4 — every row needing to be opened to learn
 * anything at all. Three letters and a number cannot be a title; a genuine
 * short one ("Bins", "Trees") is longer than that.
 */
const CODE_TITLE_RE = /^[A-Za-z]{1,3}\s?\d{0,3}$/;
const BARE_NUMBER_RE = /^\d+\s*[.)]?$/;

export function isGenericTitle(title) {
  const t = String(title ?? "").trim();
  if (!t) return true;
  if (BARE_NUMBER_RE.test(t) || CODE_TITLE_RE.test(t)) return true;
  return /^(?:acp\s+|abp\s+|board\s+)?(?:reasons?|conditions?|notes?|informatives?|directives?|prescriptions?)\b[\s:.\-]*\d*$/i.test(t);
}

/**
 * A "title" that is just the condition read back.
 *
 * Fingal and Dublin City fill the title field with the opening of the wording,
 * cut at about seventy characters — so the collapsed row showed a sentence
 * broken mid-word, and opening it showed the same sentence again, whole. It is
 * not a title, it is the text with a haircut.
 *
 * Compared after the numbering and whitespace either side writes differently:
 * Fingal's title carries a leading "1.\t" that its own text does not.
 */
const stripLead = (s) =>
  String(s ?? "")
    // Leading numbering, and the stray punctuation left when a portal writes
    // "6.\t. The following…" — Fingal does, and the orphaned full stop was
    // enough to stop the echo being recognised.
    .replace(/^[\s\u00a0]*\d*\s*[.)]*[\s\u00a0]*/, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();

/**
 * A title long enough to be a sentence is not a title.
 *
 * The portals that paste the wording cut it at about seventy characters, so
 * what arrives is a clause ending mid-word — "…Further Information (Please
 * inse". Not every one of those starts the same way as its own text, so the
 * echo test alone misses them. Fifty-six characters is past every genuine
 * title seen on the four councils, the longest being South Dublin's "SDCC
 * Development Contributions Scheme 2026 – 2028." at forty-nine.
 */
const MAX_TITLE_CHARS = 56;

export function echoesText(title, text) {
  const a = stripLead(title);
  const b = stripLead(text);
  if (!a || !b) return false;
  const overlap = Math.min(a.length, b.length, 24);
  if (overlap < 12) return false;
  return a.slice(0, overlap) === b.slice(0, overlap);
}

/**
 * The opening of the condition, cut at a word.
 *
 * The last resort, for wording that raises no theme we recognise — most house
 * conditions do not. Short enough to read as a label rather than a sentence,
 * and never broken mid-word, which is the specific ugliness this replaces.
 */
export function snippetFrom(text, words = 6) {
  const clean = String(text ?? "")
    .replace(/^[\s\u00a0]*\d*\s*[.)]*[\s\u00a0]*/, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!clean) return null;
  const parts = clean.split(" ");
  const cut = parts.slice(0, words).join(" ").replace(/[,;:.\-]+$/, "");
  return parts.length > words ? `${cut}…` : cut;
}

/** Up to two themes the text actually raises, in THEMES order. */
export function themesFor(text) {
  const s = String(text ?? "");
  if (!s.trim()) return [];
  const out = [];
  for (const [re, label] of THEMES) {
    if (!re.test(s)) continue;
    out.push(label);
    if (out.length === 2) break;
  }
  return out;
}

/** Sentence-case a joined label: "Demolition and conservation area". */
function joinThemes(themes) {
  if (!themes.length) return null;
  const [first, ...rest] = themes;
  return rest.length ? `${first} and ${rest[0].toLowerCase()}` : first;
}

/**
 * The label to show on a collapsed row.
 *
 * A title the portal actually wrote is always preferred — South Dublin's
 * "Construction hours" is better than anything derived. Only when the title is
 * generic (or absent) is one derived from the wording, falling back to the
 * numbered form when the text raises no theme we recognise, so a row is never
 * left blank.
 */
/**
 * The whole decision, filed as one condition.
 *
 * DLR does not publish its conditions separately. D20A/0569 carries a single
 * "C" item, 4,285 characters long, titled with the planner's initials, whose
 * text is the decision order itself: a "First Schedule / Reasons and
 * Considerations", the two screening determinations, then a "Second Schedule /
 * Conditions" holding all six. It is not a condition and no five-word label
 * describes it — asked for one, the model wrote "Confirm internal floor areas",
 * which is a line out of the further-information request that happened to sit
 * beside it in the same call.
 *
 * The schedule headings are what identify it, each on a line of its own. An
 * ordinary condition that merely mentions a schedule — Kildare's "subject to
 * the six conditions set out in the Schedule attached" — never matches,
 * because there the words are inside a sentence.
 */
const SCHEDULE_HEADING_RE = /^[ \t]*(?:first|second|third)\s+schedule[ \t]*$/im;

export function isDecisionSchedule(text) {
  return SCHEDULE_HEADING_RE.test(String(text ?? ""));
}

/**
 * How many conditions a decision schedule actually holds.
 *
 * The heading counts what the council attached, not how many rows we managed
 * to split it into — DLR files all six of D20A/0569's conditions as one item,
 * so "Conditions of this decision 1" told the reader there was one condition
 * on a permission carrying six.
 *
 * Read as the highest number that opens a line in the schedule's own list,
 * rather than by counting matches: sub-points ("(a)", "(b)") and the "REASON:"
 * lines under each condition break a naive count, and a numbered list that
 * restarts would inflate one.
 */
const NUMBERED_LINE_RE = /^[ \t]*(\d{1,2})\.[ \t]+\S/gm;
/** The heading the conditions themselves sit under, on a line of its own. */
const CONDITIONS_HEADING_RE = /^[ \t]*conditions[ \t]*$/im;

export function scheduleConditionCount(text) {
  const whole = String(text ?? "");
  if (!isDecisionSchedule(whole)) return null;
  // Only the part under the conditions heading — the reasons above it are
  // numbered too on some councils, and they are not conditions.
  const at = whole.search(CONDITIONS_HEADING_RE);
  const body = at >= 0 ? whole.slice(at) : whole;
  let highest = 0;
  for (const m of body.matchAll(NUMBERED_LINE_RE)) {
    highest = Math.max(highest, Number(m[1]));
  }
  // One is what the list already says, and a schedule of sixty is a parse that
  // has run away rather than a decision.
  return highest > 1 && highest <= 60 ? highest : null;
}

export function itemLabel(item, fallbackNumber) {
  // Before the council's own title: DLR's is its planner's initials, and the
  // deterministic fallbacks below would take the opening words instead — "First
  // Schedule Reasons and Considerations", which names the first section of the
  // document rather than the document.
  if (isDecisionSchedule(item?.text)) return "Schedule of conditions";
  const title = String(item?.title ?? "").trim();
  const usable =
    !isGenericTitle(title) && !echoesText(title, item?.text) && title.length <= MAX_TITLE_CHARS;
  if (usable) return title;
  const derived = joinThemes(themesFor(item?.text));
  if (derived) return derived;
  // The opening words beat "C1 1", which is what a code plus a number used to
  // produce once the code was recognised as no title at all.
  const snippet = snippetFrom(item?.text);
  if (snippet) return snippet;
  const base = title || String(item?.code_label ?? "").trim() || "Item";
  const n = item?.order || fallbackNumber;
  return n ? `${base} ${n}` : base;
}
