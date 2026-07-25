# Accounts, Saved Applications & Alerts — Design

2026-07-24

## Goal

Give PlanView users a home in the product: sign in, save any planning application,
organise saves into lists, and get alerted when a saved application changes. It must
feel premium and considered — not a bolt-on login screen with stars.

Primary use cases:

- A homeowner tracking applications they care about (their own, or ones nearby)
- Construction/development professionals tracking all their projects' statuses in one place
- Professionals researching comparables for a client: save ~10 similar applications to reference later

Out of scope for v1 (natural v2s the design leaves room for): area-watch alerts
("anything new near X"), a full notification bell/feed, AI-generated update summaries.

## Decisions made

| Question | Decision |
| --- | --- |
| Auth | Magic link only. First sign-in is sign-up. No passwords. |
| Alert channel | Email digest + in-place "Updated" badges on saved cards. No bell/feed in v1. |
| Alert scope | Changes to explicitly saved applications only. |
| Email cadence | Daily digest, sent only on days something changed. Memo style. |
| Architecture | Extend the dependency-free serverless handler; everything over HTTP (Approach A). |
| Database | Neon Postgres via its HTTP SQL API (no driver dependency). |
| Email | Resend via HTTP API. |
| Saves vs lists | Saving is flat ("everything you've saved"); lists are optional groupings on top. A saved application can be in several lists. |
| Application identity | Always `authority_id` + `planning_reference` (the natural key). Never the bundle-positional numeric id, which shifts every deploy. |
| Dual-backend rule | Deliberate exception: account/auth/alert endpoints live only in `api/index.mjs`. They cannot run locally anyway (Neon, Resend, cron are Vercel-side). The local Fastify server is untouched. |

## Data model (Neon Postgres)

Per-user tables:

- `users` — `id`, `email` (unique, lowercased), `created_at`, `last_digest_at`
- `auth_tokens` — `token_hash` (SHA-256 of the emailed token), `email`, `expires_at`
  (15 min), `used_at`. Single-use. Max 3 live tokens per email (rate limit).
- `sessions` — `token_hash`, `user_id`, `created_at`, `expires_at` (90-day rolling).
  DB-backed so logout genuinely revokes.
- `saved_apps` — `id`, `user_id`, `authority_id`, `planning_reference`,
  `alerts_enabled` (default true), `events_seen_at`, `created_at`.
  Unique on (`user_id`, `authority_id`, `planning_reference`).
- `lists` — `id`, `user_id`, `name`, `position`, `created_at`
- `list_items` — `list_id`, `saved_app_id` (membership; unique pair)

Shared tables (global, not per-user — 50 users saving the same application means one
check and one snapshot):

- `app_snapshots` — PK (`authority_id`, `planning_reference`); last-known values of the
  update-relevant fields; `fetched_at`
- `app_events` — `id`, `authority_id`, `planning_reference`, `event_type`
  (`status` | `decision` | `appeal` | `commencement` | `further_info`), `field`,
  `old_value`, `new_value`, `summary` (plain English), `detected_at`

Update-relevant fields (the snapshot/diff set): `status`, `decision`, `decision_date`,
`appeal_status`, `appeal_reference`, `appeal_lodged_date`, `appeal_decision`,
`appeal_decision_date`, `commencement_notice`, `commencement_date`, `completion_date`,
`further_info_requested_date`, `further_info_received_date`, `final_grant_date`.

## Auth (magic link)

- `POST /api/auth/request-link` `{email}` — store hashed random token, send Resend
  email ("Sign in to PlanView"). Always returns 200 regardless of whether the email has
  an account (no enumeration). Rate-limited via the live-token cap.
- `GET /api/auth/verify?token=…` — validate + burn token; create user on first
  sign-in; create session; set cookie (`httpOnly`, `Secure`, `SameSite=Lax`, 90 days);
  redirect into the account area.
- `POST /api/auth/logout` — revoke session, clear cookie.
- `GET /api/me` — current user + saves + lists in one call, fetched at app load so
  stars render instantly.

The sign-in screen is designed as part of the account experience: PlanView-branded,
explains the value ("Save applications, get alerts when they change"), one email field,
a clear "check your inbox" state.

## Saving & lists

- A star control appears on every result card, the detail panel, and map popups.
  Filled when saved. Signed out, tapping it opens the sign-in prompt and the pending
  save completes after sign-in (not lost).
- From the star, a small popover offers list membership: default is just "Saved"
  (the flat set), plus existing lists and "New list…".
- Alerts default ON per save; toggleable per application; a list-level convenience
  toggles alerts for every member.
- Endpoints (session-authed): `POST/DELETE /api/saves`, `PATCH /api/saves/:id`
  (alerts toggle, mark seen), `POST/PATCH/DELETE /api/lists`,
  `POST/DELETE /api/lists/:id/items`. All keyed by authority + planning reference.
- At save time the server seeds `app_snapshots` from the bundle record — the exact
  state the user was looking at when they saved — so the first digest never misreports
  "changes" that are just initial observation.

## Change detection & digest

Vercel cron → `GET /api/cron/check-updates` daily, protected by `CRON_SECRET` header.

1. Collect distinct (`authority_id`, `planning_reference`) across all alert-enabled saves.
2. Fetch live state per application: a per-reference query against the national
   ArcGIS dataset (status/decision/appeal, all five councils), overlaid with the
   live Agile API status for the four Dublin councils. Commencement fields come from
   the bundle, which regenerates each deploy. (Kildare-live via the eplanning parser
   is a logged v2 follow-up.)
3. Diff against `app_snapshots` on the update-relevant fields. Write `app_events`
   with human summaries, e.g. "Decision issued: Granted with conditions",
   "Appeal lodged with An Coimisiún Pleanála", "Commencement notice filed — work is
   starting". Update the snapshot.
4. Build one digest per affected user (alert-enabled saves with new events):
   memo style — subject like "Updates on 3 applications you're watching"; each entry
   names the property by address, says what changed and the new state, links to the
   application.
5. Send via Resend; stamp `users.last_digest_at`.

Failure handling: if a source is down for an application, skip it (no event, no false
alarm); it's rechecked next run. Fetch errors are logged, never emailed. The cron run
is idempotent: snapshots update as diffs are recorded, so a re-run finds no differences
and writes no duplicate events, and digests only include events newer than the user's
`last_digest_at`.

In-product: a saved card with events newer than `events_seen_at` shows a quiet
"Updated" badge; opening the application shows what changed and marks seen.

## Account experience (frontend)

A third top-level area alongside Search and Ask. React SPA additions in `web/src`:

- **Sign-in screen** — branded, minimal, premium; "check your inbox" confirmation state.
- **Dashboard** — stat row (tracked, pending, decided, updated this week), then saved
  applications as rich cards: address, status pill, key dates, aerial/mini-map thumb.
  Views: cards, compact list, or all pins on one map. Grouped by list; recently-updated
  float to the top.
- **Empty states that encourage**: fresh account → "Nothing saved yet — star any
  application in Search and it'll live here" with a nudge to search their own area;
  empty list → what lists are for.
- Stars everywhere reflect saved state from the initial `/api/me` load.

Follow the existing hand-rolled component style (no component libraries), existing
`styles.css` conventions.

## Error handling

- Session expiry mid-action: re-prompt sign-in without losing the pending action.
- Magic-link errors (expired/used token): friendly "link expired — request a fresh one".
- Neon/Resend outages: auth degrades with a clear message; cron run aborts safely and
  retries next day.

## Testing

- Pure account logic lives in small `api/accounts/*.mjs` modules (tokens, diff,
  digest assembly) imported by the handler — unlike the rest of `api/index.mjs`, which
  stays single-file. This keeps the logic importable by vitest from `server/test/`
  per the existing pattern: token lifecycle (expiry, single-use, hashing), diff logic
  (no event on identical snapshots, correct event per field, summary wording), digest
  assembly (grouping, only alert-enabled, respects `last_digest_at`).
- Live-source parsing already covered by existing tests (agile, eplanning-list, arcgis).
- Frontend verified via Vercel preview deploys (`web/` has no local node_modules;
  npm registry firewalled).

## New infrastructure

- Neon Postgres project + `DATABASE_URL` (HTTP endpoint) in Vercel env
- Resend API key (`RESEND_API_KEY`) + verified sending domain
- `CRON_SECRET` env var; `crons` entry in `vercel.json` (daily)
- (No signing secret needed: sessions are DB-backed, stored as SHA-256 of
  high-entropy random tokens)
