/**
 * Live status for Kildare saves, read straight off the council register.
 *
 * The alert cron polls the national DHLGH service, which trails Kildare by
 * roughly three months — so a Kildare application could be decided, appealed
 * and built before an alert fired. eplanning publishes the current state on
 * each application's detail page, and Kildare's planning reference *is* the
 * AppFileRefDetails id, so it can be read directly.
 *
 * Best-effort throughout: any failure returns null and the caller falls back
 * to the national snapshot.
 */
import { normalizeStatus, SNAPSHOT_FIELDS } from "./diff.mjs";

const BASE = "https://www.eplanning.ie/KildareCC/AppFileRefDetails";
const TIMEOUT_MS = 12_000;
const UA = {
  "User-Agent": "PlanView/0.1 (planning register viewer; respectful status check)",
  Accept: "text/html,application/xhtml+xml",
};

const stripTags = (h) => h.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();

const decodeEntities = (s) =>
  s
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ");

/**
 * One tab pane's markup. Labels repeat across tabs — "Decision Date" appears
 * under Details, Decision *and* Appeal — so every lookup has to be scoped or
 * an appeal date can be read as the council's.
 */
function tabSection(html, id) {
  const start = html.indexOf(`id="${id}"`);
  if (start === -1) return "";
  const rest = html.slice(start);
  const next = rest.slice(1).search(/<div class="tab-pane/);
  return next === -1 ? rest : rest.slice(0, next + 1);
}

/**
 * Value of a `<th>Label:</th><td>value</td>` pair, the page's whole structure.
 * Labels can carry markup — the appeal reference ships as
 * `<th><abbr title="An Board Pleanala">BP</abbr> Reference #:</th>` — so
 * anything is allowed ahead of the label, bounded to the same cell.
 */
function field(html, label) {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(
    `<th[^>]*>(?:(?!</th>)[\\s\\S])*?${escaped}\\s*:?\\s*</th>\\s*<td[^>]*>([\\s\\S]*?)</td>`,
    "i"
  );
  const m = html.match(re);
  if (!m) return null;
  const v = decodeEntities(stripTags(m[1])).trim();
  return v || null;
}

/** "12/06/2026" → "2026-06-12". */
function dmyToIso(v) {
  const m = String(v ?? "").match(/(\d{2})\/(\d{2})\/(\d{4})/);
  return m ? `${m[3]}-${m[2]}-${m[1]}` : null;
}

/** Kildare records the outcome as a single letter in some views. */
function expandDecisionCode(code) {
  const c = String(code ?? "").trim().toUpperCase();
  if (c === "R") return "REFUSE PERMISSION";
  if (c === "C" || c === "G" || c === "U") return "GRANT PERMISSION";
  if (c === "W") return "WITHDRAWN";
  if (c === "I") return "INVALID";
  return null;
}

/** A one-letter value is a code; anything longer is already decision text. */
function decisionText(raw) {
  if (!raw) return null;
  return raw.length <= 2 ? expandDecisionCode(raw) : raw;
}

export function snapshotFromDetailHtml(html) {
  const details = tabSection(html, "Details");
  const decisionTab = tabSection(html, "Decision");
  const appealTab = tabSection(html, "Appeal");
  // Nothing recognisable on the page: treat as unreadable rather than as an
  // application with every field empty, which would read as a mass "cleared".
  if (!details && !decisionTab) return null;

  const statusRaw = field(details, "Planning Status");
  const decision =
    decisionText(field(decisionTab, "Decision Type")) ??
    decisionText(field(details, "Decision Type"));
  const decisionDate =
    dmyToIso(field(decisionTab, "Decision Date")) ?? dmyToIso(field(details, "Decision Date"));
  const withdrawnDate = dmyToIso(field(details, "Withdrawn Date"));
  const grantDate = dmyToIso(field(decisionTab, "Grant Date"));
  const appealDecision = field(appealTab, "Appeal Decision");

  let status = normalizeStatus(statusRaw, decision);
  if ((status === "unknown" || status === "pending") && grantDate) status = "granted";
  const appealStatus = appealDecision ? normalizeStatus("decided", appealDecision) : null;
  if (appealStatus && appealStatus !== "unknown") status = appealStatus;
  if (withdrawnDate) status = "withdrawn";

  const snap = Object.fromEntries(SNAPSHOT_FIELDS.map((f) => [f, null]));
  return {
    ...snap,
    status,
    decision,
    decision_date: decisionDate,
    appeal_reference: field(appealTab, "Reference #"),
    appeal_lodged_date: dmyToIso(field(details, "Appeal Date")),
    appeal_decision: appealDecision,
    appeal_decision_date: dmyToIso(field(appealTab, "Decision Date")),
    further_info_requested_date: dmyToIso(field(details, "Further Info Requested")),
    further_info_received_date: dmyToIso(field(details, "Further Info Received")),
    final_grant_date: grantDate,
    // Kildare's own "Commenced Date" is the council's field, distinct from the
    // BCMS join the caller overlays; leave commencement_* to the caller.
  };
}

export async function fetchKildareLiveSnapshot(reference) {
  const id = String(reference ?? "").trim();
  // The reference is the AppFileRefDetails id — numeric. Anything else is a
  // legacy-format record we can't address on this endpoint.
  if (!/^\d+$/.test(id)) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${BASE}/${id}/0`, { signal: controller.signal, headers: UA });
    if (!res.ok) return null;
    return snapshotFromDetailHtml(await res.text());
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
