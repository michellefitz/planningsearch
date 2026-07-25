export async function sendEmail({ to, subject, html, text }) {
  const key = process.env.RESEND_API_KEY;
  if (!key) throw new Error("RESEND_API_KEY not set");
  const from = process.env.EMAIL_FROM ?? "PlanView <onboarding@resend.dev>";
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
    body: JSON.stringify({ from, to, subject, html, text }),
  });
  if (!res.ok) throw new Error(`resend: HTTP ${res.status} ${await res.text()}`);
}

const WRAP = (inner) => `<!doctype html>
<html><body style="margin:0;padding:0;background:#f6f7f8;font-family:Inter,system-ui,-apple-system,'Segoe UI',Roboto,sans-serif;color:#1a1d21;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:32px 16px;">
<table role="presentation" width="520" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:8px;border:1px solid #e9ebee;">
<tr><td style="padding:28px 32px 8px;font-size:15px;font-weight:600;color:#17456e;">PlanView</td></tr>
${inner}
<tr><td style="padding:16px 32px 28px;font-size:12px;color:#9aa1ab;">Planning register data for Dublin and Kildare. If you didn't expect this email, you can ignore it.</td></tr>
</table></td></tr></table></body></html>`;

export function magicLinkEmail(link) {
  const subject = "Sign in to PlanView";
  const text = `Sign in to PlanView\n\nUse the link below to sign in. It expires in 15 minutes and can be used once.\n\n${link}\n\nIf you didn't request this, you can ignore this email.`;
  const html = WRAP(`
<tr><td style="padding:8px 32px 0;font-size:20px;font-weight:600;">Sign in</td></tr>
<tr><td style="padding:12px 32px 0;font-size:14px;line-height:1.6;color:#5c6370;">Use the button below to sign in to your PlanView account. The link expires in 15 minutes and can be used once.</td></tr>
<tr><td style="padding:24px 32px;"><a href="${link}" style="display:inline-block;background:#0b62d6;color:#ffffff;text-decoration:none;font-size:14px;font-weight:600;padding:12px 24px;border-radius:8px;">Sign in to PlanView</a></td></tr>`);
  return { subject, html, text };
}
