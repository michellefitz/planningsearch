import { normalizeStatus } from "./diff.mjs";

const esc = (s) =>
  String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const STATUS_LABELS = {
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

const STATUS_COLORS = {
  granted: "#16a34a",
  refused: "#dc2626",
  pending: "#2563eb",
  further_info: "#d97706",
  withdrawn: "#6b7280",
  invalid: "#6b7280",
  split: "#9333ea",
  appealed: "#d97706",
};

function fmtDate(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(`${iso ?? ""}`);
  if (!m) return null;
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${Number(m[3])} ${months[Number(m[2]) - 1]} ${m[1]}`;
}

function statusBadge(status) {
  const s = normalizeStatus(status, null);
  const label = STATUS_LABELS[s] ?? s ?? "Unknown";
  const color = STATUS_COLORS[s] ?? "#6b7280";
  return `<span style="display:inline-block;padding:2px 8px;border-radius:4px;font-size:11px;font-weight:600;color:#fff;background:${color};">${esc(label)}</span>`;
}

function truncate(s, max = 120) {
  if (!s || s.length <= max) return s;
  return s.slice(0, max).replace(/\s+\S*$/, "") + "…";
}

function dateLine(e) {
  const parts = [];
  if (e.received_date) parts.push(`Received ${fmtDate(e.received_date)}`);
  if (e.decision_date) parts.push(`decided ${fmtDate(e.decision_date)}`);
  return parts.length ? parts.join(" · ") : null;
}

function appCard(e) {
  const dl = dateLine(e);
  return `
<tr><td style="padding:10px 32px 0;">
  <div style="border:1px solid #e9ebee;border-radius:8px;padding:16px 20px;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
      <td style="font-size:15px;font-weight:600;color:#1a1d21;">${esc(e.address)}</td>
      <td style="text-align:right;vertical-align:top;">${e.status ? statusBadge(e.status) : ""}</td>
    </tr></table>
    <div style="font-size:12px;color:#9aa1ab;font-family:ui-monospace,'SF Mono',Menlo,monospace;padding-top:2px;">${esc(e.reference)}</div>
    ${dl ? `<div style="font-size:12px;color:#9aa1ab;padding-top:4px;">${esc(dl)}</div>` : ""}
    ${e.description ? `<div style="font-size:13px;color:#5c6370;padding-top:8px;line-height:1.5;">${esc(truncate(e.description))}</div>` : ""}
    ${e.summaries?.length ? `<div style="padding-top:10px;border-top:1px solid #f0f1f3;margin-top:10px;">
      ${e.summaries.map((s) => `<div style="font-size:13px;line-height:1.6;color:#1a1d21;padding:3px 0 3px 12px;border-left:3px solid #0b62d6;">${esc(s)}</div>`).join("")}
    </div>` : ""}
    <a href="${esc(e.url)}" style="display:inline-block;padding-top:10px;font-size:13px;font-weight:600;color:#0b62d6;text-decoration:none;">View application →</a>
  </div>
</td></tr>`;
}

function wrap(title, bodyRows, unsubscribeUrl) {
  return `<!doctype html>
<html><body style="margin:0;padding:0;background:#f6f7f8;font-family:Inter,system-ui,-apple-system,'Segoe UI',Roboto,sans-serif;color:#1a1d21;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:32px 16px;">
<table role="presentation" width="560" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:8px;border:1px solid #e9ebee;">
<tr><td style="padding:28px 32px 4px;font-size:15px;font-weight:600;color:#17456e;">PlanView</td></tr>
<tr><td style="padding:8px 32px 0;font-size:19px;font-weight:600;">${esc(title)}</td></tr>
${bodyRows}
<tr><td style="padding:20px 32px 28px;font-size:12px;color:#9aa1ab;">You get this because alerts are on for saved applications or watched areas. Manage them from your PlanView account.${
    unsubscribeUrl
      ? ` <a href="${esc(unsubscribeUrl)}" style="color:#9aa1ab;text-decoration:underline;">Turn off these emails</a>.`
      : ""
  }</td></tr>
</table></td></tr></table></body></html>`;
}

function sectionHeader(label) {
  return `<tr><td style="padding:20px 32px 0;">
  <div style="font-size:12px;font-weight:600;color:#9aa1ab;text-transform:uppercase;letter-spacing:0.05em;">${esc(label)}</div>
</td></tr>`;
}

export function buildSavedAppsEmail(entries, unsubscribeUrl) {
  const n = entries.length;
  const subject =
    n === 1
      ? `Update on ${entries[0].address}`
      : `Updates on ${n} saved applications`;

  const text = entries.map((e) =>
    [
      `${e.address} (${e.reference})`,
      e.description ? `  ${truncate(e.description)}` : null,
      e.received_date ? `  Received: ${fmtDate(e.received_date)}` : null,
      e.decision_date ? `  Decision: ${fmtDate(e.decision_date)}` : null,
      ...e.summaries.map((s) => `  • ${s}`),
      `  ${e.url}`,
    ].filter(Boolean).join("\n")
  ).join("\n\n");

  const body = sectionHeader("Saved properties") + entries.map(appCard).join("");
  const html = wrap(subject, body, unsubscribeUrl);
  return { subject, html, text };
}

export function buildAreaAlertsEmail(areaSections, unsubscribeUrl) {
  const areaCount = areaSections.reduce((s, a) => s + a.items.length, 0);
  const names = areaSections.map((a) => a.name);
  const subject =
    areaCount === 1
      ? `New planning activity in ${names[0]}`
      : names.length === 1
        ? `${areaCount} new applications in ${names[0]}`
        : `New planning activity in ${names.join(", ")}`;

  const text = areaSections.map((a) =>
    [
      `In ${a.name}:`,
      ...a.items.map((i) => [
        `  ${i.summary}`,
        `  ${i.address} (${i.reference})`,
        i.description ? `  ${truncate(i.description)}` : null,
        i.received_date ? `  Received: ${fmtDate(i.received_date)}` : null,
        `  ${i.url}`,
      ].filter(Boolean).join("\n")),
    ].join("\n\n")
  ).join("\n\n");

  const body = areaSections.map((a) =>
    sectionHeader(`Area alert — ${a.name}`) +
    a.items.map((i) => appCard({
      address: i.address,
      reference: i.reference,
      url: i.url,
      description: i.description,
      status: i.status,
      received_date: i.received_date,
      decision_date: i.decision_date,
      summaries: [i.summary],
    })).join("")
  ).join("");

  const html = wrap(subject, body, unsubscribeUrl);
  return { subject, html, text };
}

/** @deprecated Use buildSavedAppsEmail and buildAreaAlertsEmail separately. */
export function buildDigestEmail(entries, unsubscribeUrl, areaSections = []) {
  if (entries.length && areaSections.length) {
    return buildSavedAppsEmail(entries, unsubscribeUrl);
  }
  if (entries.length) return buildSavedAppsEmail(entries, unsubscribeUrl);
  if (areaSections.length) return buildAreaAlertsEmail(areaSections, unsubscribeUrl);
  return { subject: "PlanView update", html: "", text: "" };
}
