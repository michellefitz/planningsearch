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
  unknown: "Unknown",
};

const STATUS_RULES: Array<[RegExp, CanonicalStatus]> = [
  [/appeal/i, "appealed"],
  [/further\s*info|f\.?i\.?\s*(req|rec)|additional information/i, "further_info"],
  [/withdraw/i, "withdrawn"],
  // "Incomplete" is a distinct pre-validation state (missing docs/fees), not
  // the same as a formally invalidated application — keep them separate.
  [/incomplete|not\s*valid/i, "incomplete"],
  [/invalid/i, "invalid"],
  [/refus|reject/i, "refused"],
  [/grant|approv|conditional|unconditional/i, "granted"],
  [/pending|new application|under consideration|awaiting|received|registered|live/i, "pending"],
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

export function normalizeStatus(raw: string | null | undefined, decision?: string | null): CanonicalStatus {
  const source = `${raw ?? ""}`.trim();
  const fromDecision = (): CanonicalStatus | null => {
    const dec = `${decision ?? ""}`.trim();
    if (!dec) return null;
    if (/refus|reject/i.test(dec)) return "refused";
    if (/grant|approv|conditional/i.test(dec)) return "granted";
    if (/withdraw/i.test(dec)) return "withdrawn";
    if (/invalid/i.test(dec)) return "invalid";
    return null;
  };
  const fromRules = (): CanonicalStatus | null => {
    for (const [re, status] of STATUS_RULES) {
      if (re.test(source)) return status;
    }
    return null;
  };
  if (source) {
    // "Finalised"/"decision made" style statuses often carry no outcome — the
    // Decision field is authoritative there. But some do embed the outcome in
    // the status itself (e.g. "Finalised Unconditional" = granted without
    // conditions), so if the Decision field is empty, still read the status
    // text before giving up.
    if (DECIDED_OPAQUE.test(source)) return fromDecision() ?? fromRules() ?? "unknown";
    const viaRules = fromRules();
    if (viaRules) return viaRules;
  }
  // Some sources leave status blank once decided; fall back to the decision text.
  const viaDecision = fromDecision();
  if (viaDecision) return viaDecision;
  return source ? "unknown" : "pending";
}

export type CanonicalApplicationType =
  | "permission"
  | "retention"
  | "outline"
  | "permission_consequent"
  | "extension_of_duration"
  | "other";

export const APPLICATION_TYPE_LABELS: Record<CanonicalApplicationType, string> = {
  permission: "Permission",
  retention: "Retention",
  outline: "Outline permission",
  permission_consequent: "Permission consequent on outline",
  extension_of_duration: "Extension of duration",
  other: "Other",
};

export function normalizeApplicationType(raw: string | null | undefined): CanonicalApplicationType {
  const s = `${raw ?? ""}`.toLowerCase();
  if (!s) return "other";
  if (/retention/.test(s)) return "retention";
  if (/outline/.test(s)) return "outline";
  if (/consequent/.test(s)) return "permission_consequent";
  if (/extension\s+of\s+duration|extend.*duration/.test(s)) return "extension_of_duration";
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
  "an bord pleanála":
    "The national planning appeals board. Either the applicant or a third party can appeal a council decision to it.",
  observation:
    "A submission any member of the public can make on a live application, usually within 5 weeks of lodgement (fee applies).",
  "decision due":
    "The statutory date by which the council must decide, usually 8 weeks after receipt unless further information is requested.",
  "final grant":
    "Issued after the decision if no appeal is lodged within 4 weeks of the decision date.",
};
