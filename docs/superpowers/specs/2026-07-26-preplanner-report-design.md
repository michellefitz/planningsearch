# Pre-planner Report — Design Spec

**Date:** 2026-07-26
**Status:** Approved for planning

## Summary

A standalone, account-gated feature: the user saves a **project** (a location plus a
free-text description of what they want to do at that property) and generates
**reports** — immutable snapshots that pull together everything PlanView can tell them
about that site: designations, heritage, flood/ground risk, nearby precedents (with
document deep-dives), area statistics, and an AI-written "things to consider" narrative.

Explicitly **not** a decision predictor. The report surfaces considerations and
precedents; it never states a likely outcome.

## Concepts & data model

- **Project** — saved intent. Fields: id, user_id, label, lat, lng, display address,
  eircode (nullable), intent text, created_at. Location is resolved at creation time
  (map pin gives coordinates directly; address/Eircode goes through the existing
  geocoding used by the agent's `geocode_location`).
- **Report** — immutable snapshot belonging to a project. Fields: id, project_id,
  status (`running` | `complete` | `error`), sections (JSON evidence pack), narrative
  (text), generated_at, error (nullable). Opening a report only renders stored data —
  it never re-runs. A project can hold multiple reports; "Run new report" creates a
  fresh one alongside the old.

Persistence lives in the accounts database (api side, where accounts already exist).
Two tables: `preplan_projects`, `preplan_reports`.

## User flow

1. Entry point: a "Pre-planner" section reachable from the header/account area, opening
   a dedicated full-screen surface (same pattern as the account dashboard). Requires
   sign-in.
2. Project list: existing projects with their latest report status; create new.
3. New project: pick location via mini-map pin **or** address/Eircode search; write the
   intent ("attic conversion with rear dormer", "demolish garage, build granny flat");
   name it; save.
4. Generate: progress screen streaming pipeline steps as they complete
   ("Checking designations… Finding precedents… Reading inspector's report…").
5. Report view: clean printable document. ⌘P produces a proper printed report via a
   print stylesheet.

## Generation pipeline

One SSE-streamed request (same event pattern as `/api/agent`). Steps, gathered in
parallel where independent:

1. **Designations** — point queries at the project coordinates against:
   zoning, natural heritage (SAC / SPA / NHA / pNHA), Zones of Archaeological
   Notification, and ACA (point-in-polygon against the baked `aca.geojson`). Each hit
   carries a plain-English "what this means for an application" line (static copy per
   designation type).
2. **Heritage points** — NIAH buildings and SMR monuments within ~250 m, via the
   ArcGIS endpoints already captured in `docs/BACKLOG.md`.
3. **Flood & ground (best-effort)** — OPW flood risk, GSI groundwater vulnerability,
   EPA radon class at the point. Endpoints to be validated during implementation; the
   previously-used national flood service was dead. If any service is unavailable, the
   section renders "couldn't be checked" — it never fails the report.
4. **Precedents** — applications within ~1 km from our database, scored by distance
   plus text relevance of the development description to the user's intent
   (keyword/heuristic scoring; no LLM call for scoring). Top ~8 listed with decision,
   status, appeal outcome. The top 2–3 decided/appealed precedents get a **document
   deep-dive**: reuse the existing document-reading machinery
   (`read_appeal_document` / `read_document` internals — fetch inspector reports and
   decision orders, read with Claude) to extract what was decided, why, and what
   conditions were imposed.
5. **Area statistics** — grant/refusal/appeal rates and median lodgement-to-decision
   times for the local authority and for the ~2 km area, plus most common application
   types nearby.
6. **AI considerations narrative** — one Claude call with the full evidence pack + the
   user's intent. Output: relevant constraints, likely condition themes, how the
   precedents bear on the proposal, exempt-development pointers, suggested development
   plan chapters. The section carries a permanent label that it is informational
   considerations, not advice or a prediction.

Budget: generation completes in ~1–2 minutes; document deep-dives are capped (max 3
documents, existing per-document size limits) to stay inside the serverless execution
limit. Every factual section is deterministic data; only the narrative and the
deep-dive extracts are LLM-written, and they are grounded in the gathered pack.

On completion the full report (sections JSON + narrative) is persisted and the stream
ends with a `done` event carrying the report id. On failure the report row is marked
`error`; partially gathered sections are still stored so the user sees what succeeded.

## API surface (api side, auth-gated)

- `POST /api/preplan/projects` — create (label, lat, lng, address, eircode?, intent).
- `GET /api/preplan/projects` — list with latest report status.
- `DELETE /api/preplan/projects/:id`
- `POST /api/preplan/projects/:id/reports` — start generation; responds as SSE
  (`progress`, `section`, `error`, `done` events).
- `GET /api/preplan/reports/:id` — fetch a stored report.

## Engineering shape

- **Dual backend rule applies to the pipeline**: evidence-gathering + synthesis logic
  in `server/src/preplan/` (TypeScript, Fastify routes, unit-tested with injected
  fetchers per the existing `buildToolExecutor` deps pattern) and mirrored in
  `api/index.mjs`. Persistence and auth gating exist only on the api side (accounts
  live there); the Fastify version runs ungated for local development.
- **Frontend**: `PrePlannerPanel` (project list + creation flow + progress screen) and
  a `ReportView` renderer, plus a print stylesheet. Follows the existing design system
  (.impeccable.md): hairlines, data-dense, status-first; motion tokens as elsewhere.
- **Testing**: vitest for the evidence-pack builders (mocked fetchers), precedent
  scoring, prompt construction, and SSE event shape. External services are not tested
  live.

## Error handling

- Per-section isolation: any external source failing yields
  `{ unavailable: true, reason }` for that section only.
- Geocoding failure blocks project creation with a clear message (pick a pin instead).
- Generation timeout/crash: report marked `error`, partial sections preserved,
  UI offers retry (which creates a new report).

## Out of scope (v1, backlogged)

- Re-run diffing ("what changed since the last report").
- Sharing links / PDF export beyond the browser print stylesheet.
- Feeding a report into the AI chat as context.
- Map layers for NIAH/SMR (separate backlog item; the report uses point queries only).
