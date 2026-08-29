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
  exempt: "Declared exempt",
  not_exempt: "Declared not exempt",
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
    // Section 5 outcomes — before grant/refuse: councils phrase certificates
    // as "GRANT/REFUSE CERTIFICATE OF EXEMPTION". Mirrors normalize.ts.
    if (/exempt/i.test(dec)) {
      const no = /not\s+exempt|refus|reject/i.test(dec);
      const yes = /exempt/i.test(dec.replace(/not\s+exempt/gi, "")) && !/refus|reject/i.test(dec);
      if (yes && no) return "split";
      return no ? "not_exempt" : "exempt";
    }
    if (/refus|reject/i.test(dec)) return "refused";
    if (/grant|approv|conditional/i.test(dec)) return "granted";
    if (/withdraw/i.test(dec)) return "withdrawn";
    if (/invalid|declared\s+inv/i.test(dec)) return "invalid";
    if (/declar|is\s+(not\s+)?development/i.test(dec)) return "decided";
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

/** ISO date → "24 Jul 2026" (email copy); non-dates pass through. */
export function fmtEventDate(v) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(`${v ?? ""}`);
  if (!m) return `${v ?? ""}`;
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${Number(m[3])} ${months[Number(m[2]) - 1]} ${m[1]}`;
}

function summarize(field, oldV, newV, next) {
  if (newV == null) return `${field.replace(/_/g, " ")} cleared`;
  switch (field) {
    case "status": return `Status changed: ${label(oldV)} → ${label(newV)}`;
    case "decision": return oldV == null ? `Decision issued: ${newV}` : `Decision updated: ${oldV} → ${newV}`;
    // Fires only when the date moved with no readable outcome alongside it
    // (a paired decision change suppresses this event) — say so, rather than
    // announcing a bare date the reader can't act on.
    case "decision_date":
      return `The register recorded a decision dated ${fmtEventDate(newV)} — the outcome isn't published yet; we'll email again when it is`;
    case "appeal_reference": return `Appeal lodged with An Coimisiún Pleanála (${newV})`;
    case "appeal_status": return `Appeal status: ${newV}`;
    case "appeal_decision": return `Appeal decided: ${newV}`;
    case "appeal_decision_date": return `Appeal decision date recorded: ${fmtEventDate(newV)}`;
    case "appeal_lodged_date": return `Appeal lodged on ${fmtEventDate(newV)}`;
    case "commencement_notice": {
      const commDate = next?.commencement_date;
      if (commDate) {
        const age = Date.now() - Date.parse(`${commDate}T00:00:00Z`);
        if (age > 180 * 86_400_000)
          return `Commencement notice filed — work commenced ${fmtEventDate(commDate)}`;
      }
      return `Commencement notice filed — work is starting`;
    }
    case "commencement_date": return `Work on site commenced ${fmtEventDate(newV)}`;
    case "completion_date": return `Works recorded complete (${fmtEventDate(newV)})`;
    case "further_info_requested_date":
      return `Further information requested on ${fmtEventDate(newV)} — the decision clock pauses until it arrives`;
    case "further_info_received_date":
      return `Further information received on ${fmtEventDate(newV)} — the council has 4 weeks to decide`;
    case "final_grant_date":
      return `Final grant issued ${fmtEventDate(newV)}${next?.decision ? ` — ${next.decision}` : ""}`;
    default: return `${field.replace(/_/g, " ")}: ${newV}`;
  }
}

/**
 * Compare a field for *meaning*, not for text.
 *
 * The baseline and the daily snapshot come from different sources — the
 * national dataset, and (for agile councils) the council's own portal — so the
 * same outcome is routinely worded differently: "GRANT PERMISSION" vs "Grant
 * Permission". Comparing raw strings turned that into "Decision updated" every
 * time the overlay flipped, which is a change in spelling, not in the world.
 */
const DECISION_OUTCOME_RE =
  /\b(grant|refus|approv|reject|withdraw|invalid|declar|exempt|permission|split|uphold|overturn|conditional)/i;

function comparable(field, value) {
  if (value == null) return null;
  if (field === "decision" || field === "appeal_decision") {
    // Anything without outcome vocabulary isn't a decision — a portal field
    // holding a job title or a stage name should never be announced as one.
    // Treated as unknown, which the null rule below then declines to alert on.
    if (!DECISION_OUTCOME_RE.test(String(value))) return null;
    return normalizeStatus(null, value);
  }
  return typeof value === "string" ? value.trim() : value;
}

export function diffSnapshots(prev, next) {
  if (prev == null) return [];
  const changed = new Set(
    SNAPSHOT_FIELDS.filter((f) => {
      const before = comparable(f, prev[f] ?? null);
      const after = comparable(f, next[f] ?? null);
      if (before === after) return false;
      // A value disappearing is nearly always a source that didn't answer —
      // BCMS down, a portal timeout — not a real-world event. Never alert on
      // it; the snapshot still records the new state.
      if (after == null) return false;
      return true;
    })
  );
  if (changed.has("decision")) changed.delete("status");
  for (const [child, parent] of Object.entries(PAIRED)) {
    if (changed.has(parent)) changed.delete(child);
  }
  // A decision date moving on its own, when the outcome is already known and
  // unchanged, is the register backfilling paperwork ("granted" said weeks
  // ago, date recorded today). Announcing it reads as an update with nothing
  // in it — the exact complaint that prompted this rule. Only alert on a bare
  // date when the case still reads undecided (a decision now exists and the
  // outcome is coming).
  const TERMINAL = new Set([
    "granted", "refused", "split", "withdrawn", "invalid", "exempt", "not_exempt", "decided",
  ]);
  if (
    changed.has("decision_date") &&
    !changed.has("decision") &&
    !changed.has("status") &&
    TERMINAL.has(normalizeStatus(next.status, next.decision))
  ) {
    changed.delete("decision_date");
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
      summary: summarize(field, old_value, new_value, next),
    });
  }
  return events;
}
