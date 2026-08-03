/**
 * Normalisation of per-council raw values onto the canonical model (PRD §8),
 * plus the best-effort domestic classifier (PRD §6.7). Every council system
 * uses different status/decision labels; the maps below cover the labels seen
 * in the national dataset and the four vendor systems, and fall back to
 * "unknown" rather than guessing.
 */

export type CanonicalStatus =
  | "pending"
  | "further_info"
  | "granted"
  | "refused"
  | "withdrawn"
  | "invalid"
  | "incomplete"
  | "appealed"
  // Part granted, part refused ("Split Decision" / "Grant Permission & Refuse
  // Permission") — a distinct outcome, not a clean grant or refusal.
  | "split"
  // Section 5 declaration outcomes — the exemption analogue of granted and
  // refused. Kept out of granted/refused so they don't skew permission grant
  // rates.
  | "exempt"
  | "not_exempt"
  // A finished case whose outcome isn't a grant/refuse or an exemption ruling
  // (e.g. "Declared to be Development", "Cannot Determine").
  | "decided"
  | "unknown";

export const STATUS_LABELS: Record<CanonicalStatus, string> = {
  pending: "Pending decision",
  further_info: "Further information",
  granted: "Granted",
  refused: "Refused",
  withdrawn: "Withdrawn",
  invalid: "Invalid",
  incomplete: "Incomplete",
  appealed: "Under appeal",
  split: "Split decision",
  exempt: "Declared exempt",
  not_exempt: "Declared not exempt",
  decided: "Decided",
  unknown: "Unknown",
};

const STATUS_RULES: Array<[RegExp, CanonicalStatus]> = [
  [/appeal/i, "appealed"],
  [/further\s*info|f\.?i\.?\s*(req|rec)|additional information/i, "further_info"],
  [/withdraw/i, "withdrawn"],
  // "Incomplete" is a distinct pre-validation state (missing docs/fees), not
  // the same as a formally invalidated application — keep them separate.
  [/incomplete|not\s*valid/i, "incomplete"],
  // The national Decision/Status text is truncated (~24 chars), so "APPLICATION
  // DECLARED INVALID" arrives as "…DECLARED INVA" — match the truncated stem too.
  [/invalid|declared\s+inv/i, "invalid"],
  // Part grant / part refuse — before the plain grant/refuse rules so it isn't
  // swallowed by whichever keyword appears first.
  [/split\s*decision|part\s*(ly)?\s*grant|grant.*(and|&|,|\/).*refus|refus.*(and|&|,|\/).*grant/i, "split"],
  [/refus|reject/i, "refused"],
  [/grant|approv|conditional|unconditional/i, "granted"],
  // Early lifecycle stages of a live application — "Validation"/"Validated",
  // "Under Assessment", "Lodged", "Acknowledged" — are pending, not "?". The
  // invalid/incomplete rules run first (so "Invalidated" is caught above), and
  // a recorded decision still supersedes this stage in normalizeStatus.
  [/pending|new application|under consideration|awaiting|received|registered|live|validat|assess|lodged|acknowledg|referral/i, "pending"],
];

/**
 * Statuses that only say "the case is closed / a decision exists" without the
 * outcome itself (e.g. the national dataset's "APPLICATION FINALISED",
 * "DECISION MADE", or the agile portals' "Decision Notice Issued" /
 * "Notification of Decision") — the real outcome lives in the Decision field,
 * so defer to it. Without this, "Decision Notice Issued" matches no rule and a
 * genuinely-decided (or declared-invalid) application reads as "unknown".
 */
// \bcomplete so "Application Complete"/"Completed" counts as closed, but
// "Incomplete Application" does not (it's a distinct pre-validation state).
const DECIDED_OPAQUE =
  /finalised|finalized|decision made|decision notice|notification of decision|decided|closed|\bcomplete/i;

// Statuses that only describe a not-yet-decided stage. When a decision is
// actually on record, it supersedes these — the national status field lags and
// can still read "Registered Application"/"New Application" years after a grant
// or refusal issued (e.g. SD22A/0440: still "Registered" in 2026, granted 2023).
const NON_TERMINAL_STAGES = new Set<CanonicalStatus>(["pending", "further_info", "incomplete"]);

function decisionToStatus(decision: string | null | undefined): CanonicalStatus | null {
  const dec = `${decision ?? ""}`.trim();
  if (!dec) return null;
  // Part grant / part refuse — check before the individual grant/refuse tests
  // so a split (which contains both words) isn't classified as just refused.
  if (/split\s*decision/i.test(dec) || (/grant|approv|conditional/i.test(dec) && /refus|reject/i.test(dec)))
    return "split";
  // Section 5 outcomes — before the grant/refuse tests, because councils
  // phrase certificates as "GRANT/REFUSE CERTIFICATE OF EXEMPTION". "Not
  // exempt" is stripped before testing for "exempt" (it contains the word);
  // exempt + not-exempt together = part yes, part no — a split.
  if (/exempt/i.test(dec)) {
    const no = /not\s+exempt|refus|reject/i.test(dec);
    const yes = /exempt/i.test(dec.replace(/not\s+exempt/gi, "")) && !/refus|reject/i.test(dec);
    if (yes && no) return "split";
    return no ? "not_exempt" : "exempt";
  }
  if (/refus|reject/i.test(dec)) return "refused";
  if (/grant|approv|conditional/i.test(dec)) return "granted";
  if (/withdraw/i.test(dec)) return "withdrawn";
  // Truncated national Decision text: "…DECLARED INVALID" arrives as "…INVA".
  if (/invalid|declared\s+inv/i.test(dec)) return "invalid";
  // Other declaration outcomes ("Declared to be Development") — a real
  // outcome, but not a grant/refuse or a clean exemption ruling.
  if (/declar|is\s+(not\s+)?development/i.test(dec)) return "decided";
  return null;
}

function statusFromRules(source: string): CanonicalStatus | null {
  for (const [re, status] of STATUS_RULES) {
    if (re.test(source)) return status;
  }
  return null;
}

export function normalizeStatus(raw: string | null | undefined, decision?: string | null): CanonicalStatus {
  const source = `${raw ?? ""}`.trim();
  const fromDecision = (): CanonicalStatus | null => decisionToStatus(decision);
  const fromRules = (): CanonicalStatus | null => statusFromRules(source);
  const viaDecision = fromDecision();
  if (source) {
    // "Finalised"/"decision made" style statuses often carry no outcome — the
    // Decision field is authoritative there. But some do embed the outcome in
    // the status itself (e.g. "Finalised Unconditional" = granted without
    // conditions), so if the Decision field is empty, still read the status
    // text before giving up.
    if (DECIDED_OPAQUE.test(source)) return viaDecision ?? fromRules() ?? "unknown";
    const viaRules = fromRules();
    // A recorded decision beats a status that is only a not-yet-decided stage
    // (the register lags); a status that itself names a terminal outcome
    // (refused/withdrawn/invalid/appealed) still stands.
    if (viaDecision && (!viaRules || NON_TERMINAL_STAGES.has(viaRules))) return viaDecision;
    if (viaRules) return viaRules;
  }
  // Some sources leave status blank once decided; fall back to the decision text.
  if (viaDecision) return viaDecision;
  return source ? "unknown" : "pending";
}

/**
 * Maps a live agile-portal status (and its decision, when present) onto a
 * canonical status. Unlike normalizeStatus it never defaults a blank read to
 * "pending" — it is only ever used to correct a baked status, and an empty
 * live read carries no signal. Mirrors mapLiveStatus in api/_index.mjs.
 */
export function mapLiveStatus(
  raw: string | null | undefined,
  decision: string | null | undefined
): CanonicalStatus {
  const s = `${raw ?? ""}`.trim();
  if (s) {
    if (DECIDED_OPAQUE.test(s)) return decisionToStatus(decision) ?? statusFromRules(s) ?? "unknown";
    const viaRules = statusFromRules(s);
    if (viaRules) return viaRules;
  }
  return decisionToStatus(decision) ?? "unknown";
}

/**
 * Expand the single-letter decision code eplanning/Kildare list tables use into
 * decision text `normalizeStatus` understands. R=Refuse, C/G/U=Grant
 * (conditional/grant/unconditional), W=Withdrawn, I=Invalid; anything else null.
 */
export function expandDecisionCode(code: string | null | undefined): string | null {
  const c = `${code ?? ""}`.trim().toUpperCase();
  if (c === "R") return "REFUSE PERMISSION";
  if (c === "C" || c === "G" || c === "U") return "GRANT PERMISSION";
  if (c === "W") return "WITHDRAWN";
  if (c === "I") return "INVALID";
  return null;
}

export type CanonicalApplicationType =
  | "permission"
  | "retention"
  | "outline"
  | "permission_consequent"
  | "extension_of_duration"
  | "exemption_declaration"
  | "council_development"
  | "strategic"
  | "other";

export const APPLICATION_TYPE_LABELS: Record<CanonicalApplicationType, string> = {
  permission: "Permission",
  retention: "Retention",
  outline: "Outline permission",
  permission_consequent: "Permission consequent on outline",
  extension_of_duration: "Extension of duration",
  exemption_declaration: "Section 5 declaration (exemption)",
  council_development: "Council development (Part 8)",
  strategic: "Strategic development (SHD / LRD / SDZ)",
  other: "Other",
};

// Patterns cover every ApplicationType string observed in the national feed
// for the five authorities since 2012 (surveyed 2026-07-28). Order matters:
// hybrids like "Permission and Retention" must not fall through to
// "permission", and "Perm. consequent on Grant of Outline Perm" must hit
// consequent before outline.
export function normalizeApplicationType(raw: string | null | undefined): CanonicalApplicationType {
  const s = `${raw ?? ""}`.toLowerCase();
  if (!s) return "other";
  if (/retention/.test(s)) return "retention";
  if (/consequent|consq|on foot of outline|following grant of outline/.test(s))
    return "permission_consequent";
  if (/outline/.test(s)) return "outline";
  if (/extension\s+of\s+duration|extend.*duration/.test(s)) return "extension_of_duration";
  if (/section\s*179a|part\s*(8|10)\b/.test(s)) return "council_development";
  if (/section\s*5|declaration of exemption|exemption/.test(s)) return "exemption_declaration";
  if (/\bshd|\blrd|\bsdz|strategic housing|strategic infrastructure/.test(s)) return "strategic";
  if (/permission|full/.test(s)) return "permission";
  return "other";
}

/**
 * The national ApplicationType field is only sparsely populated, so when it is
 * blank or unclassifiable we infer the type from the development description.
 * Only types with unambiguous wording are inferred — retention, outline,
 * extension of duration, permission-consequent — plus plain "permission" when
 * the text explicitly seeks it. Anything else stays "other" rather than
 * guessing. Retention is checked first and keyed on the whole word "retention"
 * (not "retain", which catches "retaining wall" — a normal permission), since
 * separating retention from ordinary permission is the point.
 */
export function deriveApplicationType(
  raw: string | null | undefined,
  description: string | null | undefined
): CanonicalApplicationType {
  const fromRaw = normalizeApplicationType(raw);
  if (fromRaw !== "other") return fromRaw;
  const text = `${description ?? ""}`;
  if (!text.trim()) return "other";
  if (/\bretention\b/i.test(text)) return "retention";
  if (/\boutline permission\b|\bpermission in outline\b/i.test(text)) return "outline";
  if (/extension\s+of\s+duration|extend(?:ing)?\s+the\s+duration/i.test(text))
    return "extension_of_duration";
  if (/consequent/i.test(text)) return "permission_consequent";
  if (/\bpermission\b/i.test(text)) return "permission";
  return "other";
}

/**
 * Best-effort domestic classifier (PRD F7.1). Keyword-scored over the
 * development description; deliberately conservative and never presented as
 * an official category.
 */
const DOMESTIC_SIGNALS: Array<[RegExp, number]> = [
  [/\bextension\b/i, 2],
  [/\bdormer\b/i, 2],
  [/\battic conversion\b/i, 2],
  [/\bgarage\b/i, 1],
  [/\bporch\b/i, 2],
  [/\bdwelling( house)?\b/i, 2],
  [/\bdomestic\b/i, 2],
  [/\bgarden\b/i, 1],
  [/\bfirst floor\b/i, 1],
  [/\bsingle storey\b/i, 1],
  [/\btwo storey\b/i, 1],
  [/\bbungalow\b/i, 2],
  [/\bgranny flat\b|\bfamily flat\b/i, 2],
  [/\bside\b.*\bhouse\b|\brear of\b.*\bhouse\b|\bexisting house\b/i, 1],
  [/\bconservatory\b/i, 2],
  [/\bshed\b/i, 1],
  [/\bboundary wall\b|\bfence\b/i, 1],
];

const NON_DOMESTIC_SIGNALS: Array<[RegExp, number]> = [
  [/\bapartments?\b/i, 2],
  [/\b\d{2,}\s*(no\.?\s*)?(units|houses|dwellings)\b/i, 3],
  [/\bretail\b|\bcommercial\b|\bindustrial\b|\bwarehouse\b|\boffice(s| block)?\b/i, 3],
  [/\bcreche\b|\bschool\b|\bhotel\b|\brestaurant\b|\bcafe\b|\bpub\b/i, 3],
  [/\bstrategic housing\b|\bshd\b|\blrd\b/i, 3],
  [/\bsolar farm\b|\bwind (farm|turbine)\b|\bdata centre\b|\bquarry\b/i, 3],
  [/\bagricultural\b|\bslatted\b|\bmilking\b/i, 2],
  [/\bdemolition of\b.*\b(factory|mill|works)\b/i, 2],
];

export function guessIsDomestic(description: string | null | undefined): boolean {
  const text = `${description ?? ""}`;
  if (!text) return false;
  let score = 0;
  for (const [re, w] of DOMESTIC_SIGNALS) if (re.test(text)) score += w;
  for (const [re, w] of NON_DOMESTIC_SIGNALS) if (re.test(text)) score -= w;
  return score >= 2;
}

/* ---------- one-off houses ---------- */

/**
 * A new dwelling, as descriptions phrase it: a building verb, then a dwelling
 * noun within a few words.
 */
const NEW_DWELLING_RE =
  /\b(?:construct|erect|build|provision of|permission for)\w*\s+(?:\w+\s+){0,6}?(?:dwelling|dwellinghouse|house|bungalow|residence)/i;
/** Work on a house that already exists — the opposite of a one-off. */
const EXISTING_HOUSE_WORK_RE =
  /\b(?:extension|extend|conversion|convert|attic|garage|porch|retention of|renovat|refurbish|alteration|dormer|replacement window)\b/i;
/**
 * The rural signature. A one-off house has no sewer to connect to, so it must
 * treat its own wastewater — and it says so, because the treatment system is
 * part of what is being applied for. Measured over the register, this is the
 * most reliable marker in the text: "local need", the thing these applications
 * actually turn on, appears in 3 descriptions out of 132,162.
 */
const OWN_WASTEWATER_RE =
  /\b(?:septic tank|waste ?water treatment|treatment system|treatment plant|percolation|proprietary treatment|puraflo|bio ?cycle|effluent)\b/i;

/**
 * Is this an application to build a one-off house?
 *
 * `flagRaw` is the register's own OneOffHouse field, which is authoritative
 * where a council fills it — but South Dublin is the only one of the five that
 * fills it for every application, so the description carries the rest.
 *
 * These are the hardest applications to get through: they run at a 20–57%
 * grant rate against an 82–87% baseline, depending on the council.
 */
export function isOneOffHouse(
  description: string | null | undefined,
  flagRaw?: string | null
): boolean {
  if (flagRaw && ONE_OFF_HOUSE_FLAG_RE.test(flagRaw)) return true;
  const text = `${description ?? ""}`;
  if (!text || EXISTING_HOUSE_WORK_RE.test(text)) return false;
  return NEW_DWELLING_RE.test(text) && OWN_WASTEWATER_RE.test(text);
}

/** The four spellings the councils use for "this is a one-off house". "No" and
 *  the empty string are the negatives, so the match has to be anchored. */
export const ONE_OFF_HOUSE_FLAG_RE = /^\s*(?:y|yes|one|single house)\s*$/i;

/**
 * A unit noun directly after the count, behind at most one qualifier from a
 * closed list.
 *
 * The qualifier list is deliberately an allow-list. Permitting any word here
 * reads "54 self-storage units", "51 container units" and "Units 9 - 11
 * Saunders House" as homes — measured against 3,000 real descriptions, an
 * arbitrary gap produced more wrong answers than right ones, because "unit"
 * and "house" are generic and the descriptions are long.
 */
const UNIT_NOUN =
  /^(?:(?:new|proposed|residential|additional|further|social|affordable|studio|duplex|detached|semi-detached|terraced)\s+)*(dwelling|house|home(?!\s*(?:base|office|work|care|help|farm))|apartment|duplex|unit|flat|maisonette|bungalow|townhouse|terraced house|semi-detached)/i;
// Case-insensitive: Irish planning descriptions overwhelmingly write "10 No."
// with a capital N, and without the flag the abbreviation went unrecognised —
// the count then ran into "No. houses", which is not a unit noun, and the
// whole scheme scored null.
const UNIT_COUNT = /(\d{1,4})\s*(?:no\.?\s*|nr\.?\s*|x\s*)?/gi;

/**
 * Best-effort residential unit count from the development description, used
 * when the feed's NumResidentialUnits is blank (it covers no Fingal/DLR rows
 * at all). A number counts when a unit noun follows it directly — optionally
 * via "no."/"nr."/"x" — so "3 bedroom"/"2 storey" never match. Counts inside
 * demolition/existing clauses are skipped. Descriptions state totals alongside
 * breakdowns ("50 units comprising 30 houses and 20 apartments"): take the max.
 * Where the feed disagrees with this extraction the feed is usually right
 * (amendments cite the parent scheme's numbers), so callers must prefer it.
 */
export function extractResidentialUnits(description: string | null | undefined): number | null {
  if (!description) return null;
  const text = `${description}`;
  let max = 0;
  let m: RegExpExecArray | null;
  UNIT_COUNT.lastIndex = 0;
  while ((m = UNIT_COUNT.exec(text))) {
    const n = Number(m[1]);
    if (!n || n > 2000) continue;
    // The number has to be its own token. Digits with a letter stuck straight
    // after them are an address or unit designator — "169C into a single unit"
    // is a pizza restaurant, not 169 homes — and digits with a letter before
    // them are the tail of a measurement, where "115m2 detached dwelling"
    // otherwise reads as 2 dwellings.
    if (/[A-Za-z0-9]/.test(text[m.index - 1] ?? "")) continue;
    if (m[0].length === m[1].length && /^[A-Za-z]/.test(text.slice(m.index + m[0].length))) continue;
    const after = text.slice(m.index + m[0].length, m.index + m[0].length + 40);
    if (!UNIT_NOUN.test(after)) continue;
    const before = text.slice(Math.max(0, m.index - 30), m.index).toLowerCase();
    if (/demoli|remov|replace existing|existing/.test(before)) continue;
    if (n > max) max = n;
  }
  return max || null;
}

/**
 * Jargon glossary served to the front-end for inline expansion (PRD F3.3).
 */
export const GLOSSARY: Record<string, string> = {
  "further information":
    "The council has asked the applicant for more detail before it can decide. The clock pauses until it arrives.",
  retention:
    "Permission sought for something already built or in use without planning permission.",
  "outline permission":
    "Approval in principle only — detailed drawings come later in a follow-up application.",
  "section 5 declaration":
    "A formal ruling from the council on whether particular works need planning permission or are exempt. Not a permission — a declaration of what the law already allows.",
  "declared exempt":
    "The council formally ruled that the works described do not need planning permission.",
  "declared not exempt":
    "The council formally ruled that the works described do need planning permission — like a refusal of the exemption sought.",
  "council development":
    "Development by the local authority itself (roads, housing, parks), approved by the elected members under Part 8 rather than through a planning application.",
  "strategic development":
    "Large-scale schemes decided under special routes: Strategic Housing Development (decided by the national board), Large-scale Residential Development, or development in a Strategic Development Zone.",
  "an bord pleanála":
    "The national planning appeals board. Either the applicant or a third party can appeal a council decision to it.",
  observation:
    "A submission any member of the public can make on a live application, usually within 5 weeks of lodgement (fee applies).",
  "decision due":
    "The statutory date by which the council must decide, usually 8 weeks after receipt unless further information is requested.",
  "final grant":
    "Issued after the decision if no appeal is lodged within 4 weeks of the decision date.",
};
