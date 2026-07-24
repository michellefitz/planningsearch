export const SNAPSHOT_FIELDS = [
  "status", "decision", "decision_date",
  "appeal_status", "appeal_reference", "appeal_lodged_date",
  "appeal_decision", "appeal_decision_date",
  "commencement_notice", "commencement_date", "completion_date",
  "further_info_requested_date", "further_info_received_date", "final_grant_date",
];

// Verbatim copy of server/src/normalize.ts STATUS_LABELS — keep in sync.
export const STATUS_LABELS = {
  pending: "Pending decision",
  further_info: "Further information",
  granted: "Granted",
  refused: "Refused",
  withdrawn: "Withdrawn",
  invalid: "Invalid",
  incomplete: "Incomplete",
  appealed: "Under appeal",
  split: "Split decision",
  decided: "Decided",
  unknown: "Unknown",
};

// Behavioural port of server/src/normalize.ts:42-126 — regexes copied verbatim.
const STATUS_RULES = [
  [/appeal/i, "appealed"],
  [/further\s*info|f\.?i\.?\s*(req|rec)|additional information/i, "further_info"],
  [/withdraw/i, "withdrawn"],
  [/incomplete|not\s*valid/i, "incomplete"],
  [/invalid|declared\s+inv/i, "invalid"],
  [/split\s*decision|part\s*(ly)?\s*grant|grant.*(and|&|,|\/).*refus|refus.*(and|&|,|\/).*grant/i, "split"],
  [/refus|reject/i, "refused"],
  [/grant|approv|conditional|unconditional/i, "granted"],
  [/pending|new application|under consideration|awaiting|received|registered|live|validat|assess|lodged|acknowledg|referral/i, "pending"],
];
const DECIDED_OPAQUE =
  /finalised|finalized|decision made|decision notice|notification of decision|decided|closed|\bcomplete/i;
const NON_TERMINAL_STAGES = new Set(["pending", "further_info", "incomplete"]);

export function normalizeStatus(raw, decision) {
  const source = `${raw ?? ""}`.trim();
  const fromDecision = () => {
    const dec = `${decision ?? ""}`.trim();
    if (!dec) return null;
    if (/split\s*decision/i.test(dec) || (/grant|approv|conditional/i.test(dec) && /refus|reject/i.test(dec)))
      return "split";
    if (/refus|reject/i.test(dec)) return "refused";
    if (/grant|approv|conditional/i.test(dec)) return "granted";
    if (/withdraw/i.test(dec)) return "withdrawn";
    if (/invalid|declared\s+inv/i.test(dec)) return "invalid";
    if (/exempt|declar|is\s+(not\s+)?development/i.test(dec)) return "decided";
    return null;
  };
  const fromRules = () => {
    for (const [re, status] of STATUS_RULES) if (re.test(source)) return status;
    return null;
  };
  const viaDecision = fromDecision();
  if (source) {
    if (DECIDED_OPAQUE.test(source)) return viaDecision ?? fromRules() ?? "unknown";
    const viaRules = fromRules();
    if (viaDecision && (!viaRules || NON_TERMINAL_STAGES.has(viaRules))) return viaDecision;
    if (viaRules) return viaRules;
  }
  if (viaDecision) return viaDecision;
  return source ? "unknown" : "pending";
}

export function snapshotFromBundleApp(app) {
  const snap = {};
  for (const f of SNAPSHOT_FIELDS) snap[f] = app?.[f] ?? null;
  return snap;
}

const EVENT_TYPE = {
  status: "status",
  decision: "decision", decision_date: "decision", final_grant_date: "decision",
  appeal_status: "appeal", appeal_reference: "appeal", appeal_lodged_date: "appeal",
  appeal_decision: "appeal", appeal_decision_date: "appeal",
  commencement_notice: "commencement", commencement_date: "commencement", completion_date: "commencement",
  further_info_requested_date: "further_info", further_info_received_date: "further_info",
};

// child field -> parent whose change makes the child's event redundant
const PAIRED = {
  decision_date: "decision",
  appeal_decision_date: "appeal_decision",
  appeal_lodged_date: "appeal_reference",
  commencement_date: "commencement_notice",
};

const label = (v) => STATUS_LABELS[v] ?? v ?? "—";

function summarize(field, oldV, newV) {
  if (newV == null) return `${field.replace(/_/g, " ")} cleared`;
  switch (field) {
    case "status": return `Status changed: ${label(oldV)} → ${label(newV)}`;
    case "decision": return oldV == null ? `Decision issued: ${newV}` : `Decision updated: ${oldV} → ${newV}`;
    case "decision_date": return `Decision date recorded: ${newV}`;
    case "appeal_reference": return `Appeal lodged with An Coimisiún Pleanála (${newV})`;
    case "appeal_status": return `Appeal status: ${newV}`;
    case "appeal_decision": return `Appeal decided: ${newV}`;
    case "appeal_decision_date": return `Appeal decision date: ${newV}`;
    case "appeal_lodged_date": return `Appeal lodged date: ${newV}`;
    case "commencement_notice": return `Commencement notice filed — work is starting`;
    case "commencement_date": return `Commencement date: ${newV}`;
    case "completion_date": return `Works recorded complete`;
    case "further_info_requested_date": return `Further information requested`;
    case "further_info_received_date": return `Further information received`;
    case "final_grant_date": return `Final grant issued`;
    default: return `${field.replace(/_/g, " ")}: ${newV}`;
  }
}

export function diffSnapshots(prev, next) {
  if (prev == null) return [];
  const changed = new Set(
    SNAPSHOT_FIELDS.filter((f) => (prev[f] ?? null) !== (next[f] ?? null))
  );
  if (changed.has("decision")) changed.delete("status");
  for (const [child, parent] of Object.entries(PAIRED)) {
    if (changed.has(parent)) changed.delete(child);
  }
  const events = [];
  for (const field of SNAPSHOT_FIELDS) {
    if (!changed.has(field)) continue;
    const old_value = prev[field] ?? null;
    const new_value = next[field] ?? null;
    events.push({
      field,
      event_type: EVENT_TYPE[field],
      old_value,
      new_value,
      summary: summarize(field, old_value, new_value),
    });
  }
  return events;
}
