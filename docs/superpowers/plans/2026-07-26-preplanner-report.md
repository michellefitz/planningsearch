# Pre-planner Report Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Account-gated pre-planner: save a project (location + intent), generate immutable printable reports pulling designations, heritage, flood/ground, precedents (with document deep-dives), area stats, and an AI considerations narrative.

**Architecture:** Deterministic evidence-gathering pipeline + document deep-dive on top precedents + one synthesis Claude call, streamed over SSE (same event pattern as `/api/agent`). Pipeline in `server/src/preplan/` (typed, tested, deps-injected) mirrored in `api/preplan/` (plain .mjs, dependency-free). Persistence (Neon) and auth gating only on the api side.

**Tech Stack:** TypeScript/Fastify + vitest (server), plain Node .mjs (api/Vercel), React 18 + plain CSS (web), Claude Haiku via existing `callClaude`.

## Global Constraints

- DUAL BACKEND RULE: pipeline logic lands in BOTH `server/src/preplan/*.ts` and `api/preplan/*.mjs`. Accounts/persistence only in api.
- Reports are IMMUTABLE snapshots: opening a report renders stored JSON, never re-runs.
- Per-section isolation: any external source failure yields `{ unavailable: true, reason }` for that section only; the report still completes.
- Document deep-dive cap: max 3 documents, existing per-document byte limits (10MB council / 12MB appeal).
- The considerations narrative carries a permanent "informational considerations, not advice or a prediction" label.
- Use `/usr/bin/grep` (plain `grep` is aliased). server tests: run specific vitest files only, never the whole suite. web has no node_modules — the Vercel build is the TS gate for frontend.
- Never embed secrets inline. Commit locally; do not push without explicit user approval.

---

### Task 1: Neon schema for projects & reports

**Files:**
- Modify: `scripts/migrate-accounts.mjs` (append to `STATEMENTS`)

**Interfaces:**
- Produces: tables `preplan_projects(id, user_id, label, lat, lng, address, eircode, intent, created_at)` and `preplan_reports(id, project_id, status, sections jsonb, narrative text, error text, generated_at)`.

- [ ] **Step 1: Append statements**

```js
  `create table if not exists preplan_projects (
    id bigint generated always as identity primary key,
    user_id bigint not null references users(id) on delete cascade,
    label text not null,
    lat double precision not null,
    lng double precision not null,
    address text not null,
    eircode text,
    intent text not null,
    created_at timestamptz not null default now()
  )`,
  `create table if not exists preplan_reports (
    id bigint generated always as identity primary key,
    project_id bigint not null references preplan_projects(id) on delete cascade,
    status text not null default 'running',
    sections jsonb,
    narrative text,
    error text,
    generated_at timestamptz not null default now()
  )`,
```

- [ ] **Step 2: Run migration** — `node scripts/migrate-accounts.mjs` (needs DATABASE_URL in env; pull via `vercel env pull` pattern already used). Expected: exits 0.
- [ ] **Step 3: Commit** — `git add scripts/migrate-accounts.mjs && git commit -m "feat: preplan tables"`

### Task 2: Point-data module (designations, heritage, flood/ground)

**Files:**
- Create: `server/src/preplan/point-data.ts`
- Test: `server/test/preplan-point-data.test.ts`

**Interfaces:**
- Consumes: `queryArcGis(cfg, bbox)` pattern from `server/src/overlays.ts` (reuse its export or a local equivalent with injectable fetch).
- Produces:
  - `pointBbox(lat, lng, meters?): [w,s,e,n]` — tiny envelope (~30m) for point queries.
  - `pointInPolygon(lng, lat, geojsonFeature): boolean` — ray casting over Polygon/MultiPolygon.
  - `getDesignations(lat, lng, deps): Promise<DesignationsSection>` — zoning + NPWS×4 + SMR zones via ArcGIS point queries; ACA via injected `loadStaticGeojson("aca")` + pointInPolygon.
  - `getHeritagePoints(lat, lng, deps): Promise<HeritageSection>` — NIAH + SMR points within 250m (ArcGIS `distance=250, units=esriSRUnit_Meter, geometryType=esriGeometryPoint`).
  - `getFloodGround(lat, lng, deps): Promise<FloodGroundSection>` — flood via `loadStaticGeojson("flood")` point-in-poly; radon + groundwater via best-effort ArcGIS point queries against candidate endpoints (validated in Step 1 probe); each sub-check independently `{ unavailable }`-capable.
  - Static copy map `DESIGNATION_MEANING: Record<string, string>` — one plain-English "what this means for an application" line per designation kind (zoning, SAC, SPA, NHA, pNHA, archaeology zone, ACA, flood, radon-high).

- [ ] **Step 1: Probe external endpoints (scratchpad script, not committed)** — verify NIAH (`.../NIAHBuildingsOpenData/FeatureServer/0/query`), SMR points (`.../SMROpenData/FeatureServer/0/query`) answer point-distance queries; probe EPA radon (`https://gis.epa.ie/arcgis/rest/services/EPA/RadonRiskMapNew/MapServer/0/query` and siblings) and GSI groundwater vulnerability candidates. Wire whichever answer; hard-code `unavailable: { reason: "no public service" }` for any that don't.
- [ ] **Step 2: Write failing tests** — pointInPolygon (square polygon in/out/multipolygon), pointBbox size, getDesignations with mocked fetch returning one SAC + zoning feature, getHeritagePoints mapping NIAH attrs, flood point-in-poly hit, radon fetch rejection → `{ unavailable: true }`.
- [ ] **Step 3: Run tests, verify fail** — `cd server && npx vitest run test/preplan-point-data.test.ts`
- [ ] **Step 4: Implement** — all fetchers accept `deps: { fetchJson(url): Promise<unknown>, loadStaticGeojson(name): Promise<FeatureCollection> }` so tests inject fakes. Real `loadStaticGeojson` reads `web/public/{name}.geojson` from disk (server) — path resolved relative to repo root.
- [ ] **Step 5: Tests pass + tsc** — `npx vitest run test/preplan-point-data.test.ts && npx tsc --noEmit`
- [ ] **Step 6: Commit** — `feat: preplan point-data module`

### Task 3: Precedents & area stats module

**Files:**
- Create: `server/src/preplan/precedents.ts`
- Test: `server/test/preplan-precedents.test.ts`

**Interfaces:**
- Consumes: application rows shaped like the bundle/search rows (`lat, lng, description, status, decision, decision_date, received_date, authority_id, planning_reference, address_text, appeal fields`).
- Produces:
  - `haversineMeters(lat1,lng1,lat2,lng2): number`
  - `intentTokens(intent: string): string[]` — lowercase words >3 chars minus stopwords (incl. domain stopwords: "planning","permission","build","house","property").
  - `scorePrecedent(app, tokens, distM): number` — `keywordHits * 2 + (1 - distM/1000)`; apps with no keyword hit still rank by distance.
  - `selectPrecedents(apps, lat, lng, intent, limit=8): ScoredPrecedent[]` — within 1000m, sorted by score desc.
  - `deepDiveCandidates(precedents, max=3)` — decided or appealed ones, appeals first (richest documents).
  - `areaStats(apps, lat, lng, authorityId): AreaStatsSection` — authority-wide and ≤2km: counts, grant/refusal rates (decided only), appeal count/outcomes, median lodgement-to-decision days, top 5 description keyword themes.

- [ ] **Step 1: Failing tests** — scoring favours keyword+near over far, radius cutoff at 1km, deepDiveCandidates prefers appealed, median days correct on odd/even sets, rates exclude undecided.
- [ ] **Step 2: Verify fail** → **Step 3: Implement** (pure functions, no IO) → **Step 4: Pass + tsc** → **Step 5: Commit** `feat: preplan precedent scoring and area stats`

### Task 4: Report pipeline orchestrator

**Files:**
- Create: `server/src/preplan/report.ts`
- Test: `server/test/preplan-report.test.ts`

**Interfaces:**
- Consumes: Tasks 2–3 functions; `readDocumentWithClaude` + `callClaude` from `server/src/summarize.ts`; document-fetch helpers already used by `server/src/agent/execute.ts` (appeal + council paths).
- Produces:
  - `type PreplanEvent = { type: "progress"; step: string } | { type: "section"; name: string; data: unknown } | { type: "narrative"; text: string } | { type: "done"; sections: Record<string, unknown>; narrative: string } | { type: "error"; message: string }`
  - `generateReport(input: { lat; lng; address; intent }, deps: ReportDeps): AsyncGenerator<PreplanEvent>`
  - `PREPLAN_SYNTHESIS_PROMPT` — system prompt for the narrative call.

**Pipeline order:** emit progress → run designations/heritage/flood-ground/precedents+stats in parallel (`Promise.allSettled`; a rejection becomes `{ unavailable: true, reason }`), emitting each `section` as it lands → deep-dive top candidates sequentially (progress per doc: "Reading inspector's report for F23A/0123…"), attach extracts to the precedents section → synthesis call with full pack JSON + intent → emit `narrative` then `done`.

**Synthesis prompt (verbatim core rules):**

```
You are writing the "Things to consider" section of a pre-planning research report
for a member of the public in Ireland. You are given a JSON evidence pack gathered
for their site plus their stated intention.

Rules:
- Ground every statement in the evidence pack. Never invent designations,
  precedents or statistics. If a section was unavailable, you may note it was
  not checked.
- You are NOT predicting a decision and NOT giving professional advice. Never
  state or imply a likelihood of permission.
- Structure: **Site constraints** (what the designations mean for this intent),
  **What nearby decisions show** (themes from precedents and their documents,
  cited by reference), **Likely condition themes**, **Worth checking before
  applying** (exempt-development thresholds, pre-planning meeting with the
  council, relevant development plan chapters).
- Plain English, no legalese. 350-550 words. Markdown with the four bold
  headings above only.
```

- [ ] **Step 1: Failing tests** — with fully faked deps: event order (progress before section, done last), a rejecting designations dep yields `{ unavailable }` section not a crash, deep-dive capped at 3 and its extracts land under `precedents.deep_dives`, narrative comes from faked callClaude and `done` carries all sections.
- [ ] **Step 2: Verify fail** → **Step 3: Implement** → **Step 4: Pass + tsc** → **Step 5: Commit** `feat: preplan report pipeline`

### Task 5: Fastify route (local/dev, ungated)

**Files:**
- Modify: `server/src/api.ts` (after the `/api/agent` route)
- Test: `server/test/preplan-route.test.ts` (event stream shape via fastify.inject)

**Interfaces:**
- Produces: `POST /api/preplan/generate` — body `{ lat, lng, address, intent }`, responds `text/event-stream`, writes `data: {json}\n\n` per PreplanEvent. Real deps assembled like `buildToolExecutor`'s REAL_DEPS (db search for precedents source rows via a bbox/`nearby` query; static geojson from `web/public`).

- [ ] Steps: failing inject test (400 on missing intent; happy path with injected fake generator emits done) → implement → pass + tsc → commit `feat: preplan SSE route (fastify)`

### Task 6: api mirror — persistence, auth-gated routes, pipeline

**Files:**
- Create: `api/preplan/pipeline.mjs` (mirror of Tasks 2–4 logic, plain JS, deps from BUNDLE + fetch)
- Create: `api/preplan/routes.mjs`
- Modify: `api/index.mjs` (import + route dispatch before generic handling, alongside `isAccountRoute`)

**Interfaces:**
- `isPreplanRoute(route)` — `/api/preplan/*`.
- `handlePreplanRoute(req, res, route, url, ctx)` where ctx supplies `{ bundle, callClaude, readDocumentWithClaude, documentFetchers }` from index.mjs.
- Routes (all except none are auth-gated via `currentUser` from `api/accounts/routes.mjs` — export it or duplicate the 8-line helper into `api/preplan/routes.mjs` reading the same cookie):
  - `GET /api/preplan/projects` — list with latest report id/status per project (`select distinct on (project_id) ...` or order-by-latest join).
  - `POST /api/preplan/projects` — validate label/lat/lng/address/intent; insert; return row.
  - `DELETE /api/preplan/projects/:id` — scoped to user.
  - `POST /api/preplan/projects/:id/reports` — insert `running` report row, stream SSE from pipeline, persist sections/narrative + `complete` on done (or `error` + partial sections on failure), final `done` event carries `report_id`.
  - `GET /api/preplan/reports/:id` — stored report joined to project (user-scoped).
- Static geojson on api side: fetch own origin — `https://${req.headers.host}/aca.geojson` (and flood) with an in-memory module cache.
- Precedent source rows: filter `BUNDLE.applications` by haversine ≤1km (they carry lat/lng).

- [ ] Steps: write `pipeline.mjs` (port point-data + precedents + report generator; identical event shapes and prompt text) → write `routes.mjs` (CRUD + SSE, `sendPrivate`-style no-store JSON) → wire dispatch in `index.mjs` → `node --check api/index.mjs api/preplan/*.mjs` → commit `feat: preplan api routes + pipeline (vercel)`

### Task 7: Frontend — PrePlannerPanel, report view, print

**Files:**
- Create: `web/src/components/PrePlannerPanel.tsx` (project list + create form + generation progress)
- Create: `web/src/components/ReportView.tsx` (immutable report renderer)
- Modify: `web/src/App.tsx` (mode `"preplan"`, nav link next to Dashboard, full-screen destination like account mode)
- Modify: `web/src/api.ts` (types + client: `preplanProjects()`, `createPreplanProject()`, `deletePreplanProject()`, `getPreplanReport()`, `generatePreplanReport(projectId, onEvent)` SSE reader like ChatPanel's)
- Modify: `web/src/styles.css` (preplan + report styles, `@media print` block)

**Key UX decisions (already approved):**
- Entry: header nav "Pre-planner" (signed-in only; signed-out click routes to sign-in like Dashboard).
- Create form: label, intent textarea, location via (a) address/Eircode search using existing `/api/suggest`+register geocode — a small search input listing matching register addresses with coordinates, or (b) mini MapLibre map (reuse map style URL from MapView) where a click drops a pin; show resolved coords/address; geocode failure message points at the pin option.
- Generation screen: streamed step list with the same progress affordances as chat tool_start labels; sections tick as they land.
- Report view: document layout — header (label, address, intent, generated date, "Report #n"), designation grid, heritage list, flood/ground statuses, precedent table (ref, distance, decision, appeal) + deep-dive extract blocks, area stats row, narrative with the permanent disclaimer line under the heading.
- Print: `@media print` hides app chrome (header/nav/footer/buttons), report becomes full-width black-on-white, page-break rules before major sections (`break-inside: avoid` on blocks).
- Opening an existing report = `GET /api/preplan/reports/:id` render only. "Run new report" button on the project starts a fresh generation.

- [ ] Steps: api.ts client + types → PrePlannerPanel + ReportView → App wiring → styles + print block → commit `feat: pre-planner UI`. TS gate is the Vercel build (no local node_modules).

### Task 8: Deploy & verify

- [ ] Deploy to prod (`vercel --prod` from repo root as usual). Vercel CLI prints its table to stderr — don't discard it.
- [ ] Verify frontend live: new `assets/index-*.js` hash + grep bundle for `preplan` marker string absent from old bundle.
- [ ] E2E in prod: sign in, create a project at a known Kildare/Fingal location with intent "attic conversion with rear dormer", generate, confirm: sections stream, at least one deep-dive runs, report persists and re-opens without regenerating, ⌘P layout sane (spot-check via print preview).
- [ ] Update `docs/BACKLOG.md`: mark NIAH/SMR point usage shipped in preplan (map layers still pending); add v1-out-of-scope items (re-run diffing, share/PDF export, report-as-chat-context).
- [ ] Commit docs; hold push until user approves.

## Self-Review

- Spec coverage: model→T1, designations/heritage/flood→T2, precedents/stats→T3, pipeline+narrative+cap→T4, dual backend→T5+T6, persistence/auth/API surface→T6, UI/print/immutability→T7, error-isolation→T2/T4, verification→T8. Geocoding = register-match approach (T7 create form) per existing `geocode_location` semantics. No gaps.
- Placeholders: endpoint probing in T2 Step 1 is a deliberate validated-at-build step per spec ("endpoints to be validated during implementation"), not a TBD.
- Type consistency: `PreplanEvent`, `generateReport(input, deps)`, section names (`designations`, `heritage_points`, `flood_ground`, `precedents`, `area_stats`) used consistently across T4–T7.
