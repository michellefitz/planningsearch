import crypto from "node:crypto";

export const SESSION_COOKIE = "pv_session";
const SESSION_MAX_AGE = 90 * 86400;

export function randomToken() {
  return crypto.randomBytes(32).toString("hex");
}

export function sha256Hex(s) {
  return crypto.createHash("sha256").update(s).digest("hex");
}

export function unsubscribeToken(userId) {
  const key = process.env.CRON_SECRET;
  if (!key) throw new Error("CRON_SECRET is required for unsubscribe tokens");
  return crypto
    .createHmac("sha256", key)
    .update(`unsub:${userId}`)
    .digest("hex");
}

export function verifyUnsubscribeToken(userId, token) {
  const expected = unsubscribeToken(userId);
  if (typeof token !== "string" || token.length !== expected.length) return false;
  return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(token));
}

export function parseCookies(header) {
  const out = {};
  for (const part of (header ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

export function sessionCookie(token) {
  return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${SESSION_MAX_AGE}`;
}

export function clearSessionCookie() {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
}
