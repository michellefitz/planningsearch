# PlanView Security Audit

**Date:** 4 August 2026
**Scope:** Full application — authentication, session management, API cost abuse, input validation/injection, client bundle secrets, Vercel infrastructure config.
**Context:** Pre-launch audit before sharing the app publicly.

---

## What's solid

- **SQL injection:** Parameterised queries throughout (Neon HTTP SQL uses `$N` placeholders in every query across routes.mjs, watches.mjs, harvest.mjs, db.mjs).
- **HTML escaping:** Consistent in digest emails (`esc()` in digest.mjs), map popups (`escapeHtml` in MapView.tsx), and server-rendered pages.
- **No server secrets in client bundle:** No ANTHROPIC_API_KEY, RESEND_API_KEY, CRON_SECRET, DATABASE_URL, or GitHub tokens in the built JS. Only VITE_-prefixed vars reach the client (Vite default).
- **Cookie flags:** HttpOnly, Secure, SameSite=Lax, Path=/, 90-day Max-Age — all correct.
- **Session tokens:** 256-bit entropy via `crypto.randomBytes(32)`, stored as SHA-256 hash only; raw token never persisted.
- **Magic link single-use:** Atomic `UPDATE ... WHERE used_at IS NULL AND expires_at > now() RETURNING` — replay is impossible.
- **No account enumeration:** `/api/auth/request-link` always returns `{ ok: true }` regardless of whether the email exists.
- **CORS:** No `Access-Control-Allow-Origin` header set, so browser default (same-origin) applies. Cookie-bearing endpoints not readable cross-origin.
- **IDOR protection:** Every SQL touching user-owned resources includes `AND user_id = $N`. All 12+ mutation queries verified.
- **Cron auth fails closed:** Both cron endpoints check `!secret || ...` so an unset CRON_SECRET yields 401.
- **CSRF:** SameSite=Lax blocks cross-site POST cookies. State-changing endpoints require POST/PATCH/DELETE with JSON bodies.
- **Error disclosure:** Top-level catch returns generic `{ error: "something went wrong" }`. Internals go to `console.error` only.
- **No dangerous JS sinks:** No `eval()`, `new Function()`, `document.write()`, `innerHTML` assignments, or `dangerouslySetInnerHTML` in any web source.
- **No .env files in git:** `.gitignore` covers `.env` at both root and web/ level.
- **Deployment hygiene:** `.vercelignore` excludes `.git`, `node_modules`, `.worktrees`. No secrets baked into build output.

---

## Findings

### 1. CRITICAL — `/api/agent` is wide open (cost abuse)

**File:** `api/_index.mjs` (handleAgentRoute)
**Risk:** No auth required, no rate limiting, no client-disconnect abort. Each request makes up to 12 Claude Sonnet 5 calls (AGENT_MAX_TURNS=12, AGENT_MAX_TOKENS=4000) plus Haiku document-reading calls.
**Cost exposure:** A script hitting this endpoint could run up $30K–$120K/hour in Anthropic API costs.
**Additional issue:** The `runAgent` generator runs to completion even if the SSE client disconnects — no check on `res.destroyed`.
**Fix:** Per-IP rate limit (e.g. 10 requests/hour), abort chain on client disconnect, cap individual message sizes, consider requiring auth.

### 2. HIGH — Email flooding via `/api/auth/request-link`

**File:** `api/_accounts/routes.mjs:159-180`
**Risk:** Rate limit is 3 tokens per email address, but no per-IP limit. An attacker can loop over arbitrary victim addresses — burning Resend quota and getting the sending domain flagged as spam.
**Fix:** Per-IP rate limit (5 requests/15 minutes). Vercel WAF rate-limit rule on this path is zero-code.

### 3. HIGH — Unauthenticated Haiku summary endpoints are sweepable

**Files:** `api/_index.mjs` — `/api/applications/:id/appeal-summary`, `/decision-summary`, `/enrich`
**Risk:** Each calls Claude Haiku with no auth. Iterating ~45K app IDs costs ~$450. In-memory cache mitigates repeat calls but not a first-pass sweep.
**Fix:** Global call counter (60 Haiku calls/minute), or require auth for AI summary routes.

### 4. HIGH — Preplan reports have no per-user generation limit

**File:** `api/_preplan/routes.mjs:231-285`
**Risk:** Authenticated, but no per-user cap. Each report makes multiple Haiku+Sonnet calls (~$0.05–$0.20/report). Scriptable abuse.
**Fix:** Per-user cap (e.g. 5 reports/day).

### 5. HIGH — Magic link consumed by GET request

**File:** `api/_accounts/routes.mjs:183-213`
**Risk:** Corporate email scanners (Outlook SafeLinks, antivirus) prefetch links. The GET both consumes the single-use token and issues a session cookie to the scanner. The human's click then sees "link expired."
**Fix:** Verify page should render a "Complete sign-in" button that POSTs the token; create session only on POST.

### 6. MEDIUM — No security headers

**File:** `scripts/build-vercel.mjs`
**Risk:** No Content-Security-Policy, X-Frame-Options, X-Content-Type-Options, Referrer-Policy, or Permissions-Policy. Document proxy serves council-uploaded PDFs/images inline — `nosniff` matters there.
**Fix:** Add a headers route in build-vercel.mjs config.

### 7. MEDIUM — Unsubscribe HMAC key defaults to empty string

**File:** `api/_accounts/tokens.mjs:17`
**Risk:** `process.env.CRON_SECRET ?? ""` — if CRON_SECRET is ever unset, unsubscribe tokens become forgeable. Anyone could disable any user's alerts.
**Fix:** Throw if CRON_SECRET is missing instead of defaulting.

### 8. MEDIUM — `APP_ORIGIN` falls back to `req.headers.host`

**File:** `api/_accounts/routes.mjs:177`
**Risk:** Host-header-poisoning shape for magic-link emails. On Vercel the Host header is constrained, but it's one platform assumption away from account takeover.
**Fix:** Set APP_ORIGIN explicitly in Vercel env; fail (not fall back) when missing for auth links.

### 9. MEDIUM — Mapbox + Google Maps tokens may lack URL restrictions

**Files:** `web/src/components/PropertyMedia.tsx:13`, `web/src/components/ReportView.tsx:17`, `web/src/components/MapView.tsx`
**Risk:** Public tokens in client bundle (expected), but if not restricted to the domain in their respective dashboards, anyone can use them on your billing account. Mapbox: ~$450 at 1M static image requests.
**Fix:** Verify URL/referrer restrictions in Mapbox and Google Cloud dashboards.

### 10. MEDIUM — No cap on saves or lists per user

**File:** `api/_accounts/routes.mjs:348-397`
**Risk:** Watches are capped at 10, but saves and lists have no limit. An authenticated user could create unlimited rows.
**Fix:** Add count checks (max 200 saves, max 50 lists).

### 11. MEDIUM — Unbounded string inputs on saves and lists

**File:** `api/_accounts/routes.mjs:349-352, 389`
**Risk:** `authority_id`, `planning_reference`, and list `name` have no length limit. Watch `name` correctly uses `.slice(0, 80)`.
**Fix:** Add `.slice(0, N)` on these fields.

### 12. LOW — Cron secret compared with `!==` (not timing-safe)

**File:** `api/_accounts/routes.mjs:261, 454`
**Risk:** Non-constant-time comparison. Practically unexploitable over network jitter, but trivial to fix since `timingSafeEqual` is already imported.
**Fix:** Hash both sides and use `crypto.timingSafeEqual`.

### 13. LOW — No session invalidation on re-authentication

**File:** `api/_accounts/routes.mjs:197-212`
**Risk:** New session created without revoking prior sessions. Multiple sessions coexist indefinitely.
**Fix:** `DELETE FROM sessions WHERE user_id = $1` before creating new session.

### 14. LOW — Agent message content not size-capped

**File:** `api/_index.mjs:2590-2598`
**Risk:** Messages capped to 30, but each message has no individual size limit. Amplifies cost of finding #1.
**Fix:** Cap individual message content to ~10K chars, total to ~50K chars.

### 15. LOW — `readJsonBody` has no size limit

**File:** `api/_index.mjs:2577-2585`, `api/_accounts/routes.mjs:41-49`
**Risk:** Buffers entire body into memory with no cap. Mitigated by Vercel's 4.5 MB serverless body limit, but not if code runs outside Vercel.
**Fix:** Add byte counter, bail after 512 KB.

### 16. LOW — Watch-creation seeding does sequential DB round-trips

**File:** `api/_accounts/routes.mjs:315-323`
**Risk:** A 10 km watch over Dublin can seed thousands of rows via individual Neon HTTP calls. Authenticated-only, but a latency/cost lever.
**Fix:** Batch into single multi-row INSERT.

### 17. INFO — No robots.txt

**Risk:** SPA and all GET API endpoints are crawlable. Data is public-record so not a leak, but scrapers hitting AI routes add to cost exposure.
**Fix:** Add robots.txt disallowing `/api/`.

### 18. INFO — Session hygiene

**Risk:** 90-day fixed-expiry sessions with no rotation, no idle timeout, no "sign out everywhere", no cleanup job for expired rows. Cookie could use `__Host-` prefix.
**Fix:** Non-urgent for launch; consider adding later.

### 19. INFO — Unescaped `fallbackUrl` in document proxy HTML

**File:** `api/_index.mjs:2787`
**Risk:** Not exploitable — value comes from bundle data (hardcoded URL patterns), not user input. Belt-and-braces fix: run through `esc()`.

---

## Fix status

| # | Status | PR |
|---|--------|-----|
| 1 | Fixed | #19 — Agent rate limit (20/hr/IP), disconnect abort, body+message caps |
| 2 | Fixed | #19 — Auth request-link rate limit (5/15min/IP) |
| 3 | Fixed | #19 — APP_ORIGIN required (already set in Vercel prod) |
| 4 | Fixed | #19 — CRON_SECRET throws when missing |
| 5 | Fixed | #19 — Magic link two-step verify (GET page → POST consumes) |
| 6 | Fixed | #19 — Security headers (nosniff, DENY, referrer, permissions) |
| 7 | Fixed | #20 — Global AI rate limit (30/min) on Haiku summary routes |
| 8 | Manual | Verify Mapbox + Google Maps token URL restrictions in dashboards |
| 9 | Fixed | #20 — Preplan reports capped at 5/user/day |
| 10 | Fixed | #20 — Saves capped at 200, lists at 50 per user |
| 11 | Fixed | #20 — String inputs truncated to 80 chars |
| 12 | Fixed | #20 — Timing-safe cron Bearer comparison |
| 13 | Open | Session invalidation on re-auth (low priority) |
| 14 | Fixed | #19 — Agent message content capped at 10K chars |
| 15 | Fixed | #19 — readJsonBody size limits (100KB/50KB) |
| 16 | Fixed | #20 — Watch seeding batched into single INSERT |
| 17 | Fixed | #20 — robots.txt disallowing /api/ |
| 18 | Open | Session hygiene — rotation, idle timeout, cleanup (low priority) |
| 19 | Open | Unescaped fallbackUrl in doc proxy HTML (not exploitable) |
