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
  // Applications arrive here with the register's status already normalised to
  // a slug. Re-normalising treats that slug as raw council text, and the rules
  // are written for prose: "further_info" matches no rule because of the
  // underscore, so five of the twelve statuses came out "Unknown" — an email
  // about a further-information request said nothing about its status at all.
  const s = status in STATUS_LABELS ? status : normalizeStatus(status, null);
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
  if (e.decision_date) parts.push(`Decided ${fmtDate(e.decision_date)}`);
  return parts.length ? parts.join(" · ") : null;
}

/**
 * Why this email exists, at the top of the card where it is read first.
 *
 * This used to sit at the bottom, under the address, the reference, the dates
 * and the description — so a mail full of commencement notices looked like a
 * mail full of addresses, and the one line saying what had actually happened
 * was the last thing on the card. It leads now, with the date it happened.
 *
 * Colour is by kind of news rather than by outcome: the status badge beside
 * the address already carries grant-or-refuse, and saying it twice in two
 * palettes only makes the card harder to read. Tints are literal hex because
 * colour-mix does not survive an email client.
 */
const ACTIVITY_ACCENT = {
  decision: { bar: "#0b62d6", bg: "#eef4ff", fg: "#12305c" },
  commencement: { bar: "#0f766e", bg: "#ecf7f5", fg: "#124f49" },
  appeal: { bar: "#d97706", bg: "#fdf5e9", fg: "#7c4a08" },
  further_info: { bar: "#d97706", bg: "#fdf5e9", fg: "#7c4a08" },
  new: { bar: "#0b62d6", bg: "#eef4ff", fg: "#12305c" },
  status: { bar: "#6b7280", bg: "#f3f4f6", fg: "#374151" },
};

function activityBand(activity) {
  if (!activity?.length) return "";
  return activity
    .map((a) => {
      const c = ACTIVITY_ACCENT[a.kind] ?? ACTIVITY_ACCENT.status;
      const when = fmtDate(a.date);
      return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:12px;">
      <tr>
        <td width="4" style="background:${c.bar};border-radius:2px;font-size:0;line-height:0;">&nbsp;</td>
        <td style="background:${c.bg};padding:9px 12px;border-radius:0 4px 4px 0;">
          <div style="font-size:14px;font-weight:600;line-height:1.4;color:${c.fg};">${esc(a.text)}</div>
          ${when ? `<div style="font-size:12px;color:${c.fg};opacity:0.75;padding-top:2px;">${esc(when)}</div>` : ""}
        </td>
      </tr></table>`;
    })
    .join("");
}

function appCard(e) {
  const dl = dateLine(e);
  // The plain-English summary where one has been generated; the council's own
  // description only as a fallback, since it is written for a file and gets
  // cut mid-sentence at this width.
  const blurb = e.summary ?? (e.description ? truncate(e.description) : null);
  return `
<tr><td style="padding:10px 32px 0;">
  <div style="border:1px solid #e9ebee;border-radius:8px;padding:16px 20px;">
    ${activityBand(e.activity)}
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
      <td style="font-size:15px;font-weight:600;color:#1a1d21;">${esc(e.address)}</td>
      <td style="text-align:right;vertical-align:top;">${e.status ? statusBadge(e.status) : ""}</td>
    </tr></table>
    <div style="font-size:12px;color:#9aa1ab;font-family:ui-monospace,'SF Mono',Menlo,monospace;padding-top:2px;">${esc(e.reference)}</div>
    ${dl ? `<div style="font-size:12px;color:#9aa1ab;padding-top:4px;">${esc(dl)}</div>` : ""}
    ${blurb ? `<div style="font-size:13px;color:#5c6370;padding-top:8px;line-height:1.5;">${esc(blurb)}</div>` : ""}
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
      ...(e.activity ?? []).map((a) =>
        fmtDate(a.date) ? `${a.text} — ${fmtDate(a.date)}` : a.text
      ),
      `${e.address} (${e.reference})`,
      e.summary ?? (e.description ? `  ${truncate(e.description)}` : null),
      e.received_date ? `  Received: ${fmtDate(e.received_date)}` : null,
      e.decision_date ? `  Decided: ${fmtDate(e.decision_date)}` : null,
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
        `  ${i.summary}${fmtDate(i.activity_date) ? ` — ${fmtDate(i.activity_date)}` : ""}`,
        `  ${i.address} (${i.reference})`,
        i.summary_text ?? (i.description ? `  ${truncate(i.description)}` : null),
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
      summary: i.summary_text ?? null,
      status: i.status,
      received_date: i.received_date,
      decision_date: i.decision_date,
      activity: [{ kind: i.kind, text: i.summary, date: i.activity_date ?? null }],
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
