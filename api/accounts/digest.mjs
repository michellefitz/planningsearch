const esc = (s) =>
  String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export function buildDigestEmail(entries) {
  const n = entries.length;
  const subject =
    n === 1 ? `Update on ${entries[0].address}` : `Updates on ${n} applications you're watching`;

  const text = [
    n === 1 ? "There's been an update on an application you're watching." :
      `There have been updates on ${n} applications you're watching.`,
    "",
    ...entries.map((e) =>
      [`${e.address} (${e.reference})`, ...e.summaries.map((s) => `  - ${s}`), `  ${e.url}`].join("\n")
    ),
  ].join("\n\n");

  const blocks = entries
    .map(
      (e) => `
<tr><td style="padding:16px 32px 0;">
  <div style="border:1px solid #e9ebee;border-radius:8px;padding:16px 20px;">
    <div style="font-size:15px;font-weight:600;color:#1a1d21;">${esc(e.address)}</div>
    <div style="font-size:12px;color:#9aa1ab;font-family:ui-monospace,'SF Mono',Menlo,monospace;padding-top:2px;">${esc(e.reference)}</div>
    <ul style="margin:10px 0 12px;padding-left:18px;font-size:14px;line-height:1.6;color:#5c6370;">
      ${e.summaries.map((s) => `<li>${esc(s)}</li>`).join("")}
    </ul>
    <a href="${esc(e.url)}" style="font-size:13px;font-weight:600;color:#0b62d6;text-decoration:none;">View application →</a>
  </div>
</td></tr>`
    )
    .join("");

  const html = `<!doctype html>
<html><body style="margin:0;padding:0;background:#f6f7f8;font-family:Inter,system-ui,-apple-system,'Segoe UI',Roboto,sans-serif;color:#1a1d21;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:32px 16px;">
<table role="presentation" width="560" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:8px;border:1px solid #e9ebee;">
<tr><td style="padding:28px 32px 4px;font-size:15px;font-weight:600;color:#17456e;">PlanView</td></tr>
<tr><td style="padding:8px 32px 0;font-size:19px;font-weight:600;">${esc(subject)}</td></tr>
${blocks}
<tr><td style="padding:20px 32px 28px;font-size:12px;color:#9aa1ab;">You get this because alerts are on for these saved applications. Manage them from your PlanView account.</td></tr>
</table></td></tr></table></body></html>`;

  return { subject, html, text };
}
