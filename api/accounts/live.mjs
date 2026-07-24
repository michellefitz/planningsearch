import { normalizeStatus, SNAPSHOT_FIELDS } from "./diff.mjs";

const SERVICE_URL =
  "https://services.arcgis.com/NzlPQPKn5QF9v2US/arcgis/rest/services/IrishPlanningApplications/FeatureServer/0";

const NATIONAL_LIKE = {
  "dublin-city": "Dublin City",
  fingal: "Fingal",
  dlr: "Rathdown",
  "south-dublin": "South Dublin",
  kildare: "Kildare",
};

const str = (v) => {
  if (v == null) return null;
  const s = String(v).trim();
  return s.length ? s : null;
};

const isoDate = (v) => {
  if (v == null || v === "") return null;
  const n = typeof v === "number" ? v : Date.parse(String(v));
  if (!Number.isFinite(n)) return null;
  return new Date(n).toISOString().slice(0, 10);
};

export function attrsToSnapshot(attrs) {
  const statusRaw = str(attrs.ApplicationStatus);
  const decision = str(attrs.Decision);
  const snap = Object.fromEntries(SNAPSHOT_FIELDS.map((f) => [f, null]));
  return {
    ...snap,
    status: normalizeStatus(statusRaw, decision),
    decision,
    decision_date: isoDate(attrs.DecisionDate),
    appeal_status: str(attrs.AppealStatus),
    appeal_reference: str(attrs.AppealRefNumber),
    appeal_lodged_date: isoDate(attrs.AppealSubmittedDate),
    appeal_decision: str(attrs.AppealDecision),
    appeal_decision_date: isoDate(attrs.AppealDecisionDate),
    further_info_requested_date: isoDate(attrs.FIRequestDate),
    further_info_received_date: isoDate(attrs.FIRecDate),
    final_grant_date: isoDate(attrs.GrantDate),
  };
}

export async function fetchLiveNationalSnapshot(authorityId, reference) {
  const like = NATIONAL_LIKE[authorityId];
  if (!like) return null;
  const ref = reference.replace(/'/g, "''");
  const where = `ApplicationNumber='${ref}' AND PlanningAuthority LIKE '%${like}%'`;
  const url = `${SERVICE_URL}/query?f=json&returnGeometry=false&outFields=*&where=${encodeURIComponent(where)}`;
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const data = await res.json();
    const attrs = data.features?.[0]?.attributes;
    return attrs ? attrsToSnapshot(attrs) : null;
  } catch {
    return null;
  }
}
