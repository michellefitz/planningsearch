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
 */
export function isGenericTitle(title) {
  const t = String(title ?? "").trim();
  if (!t) return true;
  return /^(?:acp\s+|abp\s+|board\s+)?(?:reasons?|conditions?|notes?|informatives?|directives?|prescriptions?)\b[\s:.\-]*\d*$/i.test(t);
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
export function itemLabel(item, fallbackNumber) {
  const title = String(item?.title ?? "").trim();
  if (!isGenericTitle(title)) return title;
  const derived = joinThemes(themesFor(item?.text));
  if (derived) return derived;
  const base = title || String(item?.code_label ?? "").trim() || "Item";
  const n = item?.order || fallbackNumber;
  return n ? `${base} ${n}` : base;
}
