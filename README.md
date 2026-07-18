# PlanView — Unified Irish Planning Permission Viewer

One search, one map, one clean application view over the planning registers of
five local authorities: **Dublin City, Fingal, Dún Laoghaire-Rathdown, South
Dublin and Kildare**. Full product spec in [docs/PRD.md](docs/PRD.md).

This implements **Phase 1** of the PRD: cross-authority search (F1), unified
map (F2) and the single-page application view (F3), built purely on open
metadata, with documents deep-linked out to the official council portals (the
F4.7 floor). The schema and document-access service boundary are in place for
Phase 2 (in-place document viewer).

## Stack

- `server/` — Fastify + SQLite (better-sqlite3). Canonical store per PRD §8,
  FTS5 full-text search with a trigram fallback for typo tolerance
  ("manooth" finds Maynooth), status/type normalisation across the four
  vendor systems, best-effort domestic classifier, and per-council deep-link
  builders.
- `web/` — Vite + React + MapLibre GL. Map-first SPA: clustered status-coded
  pins (colour **plus** letter glyph, never colour alone), synced list/map,
  filter chips, narrative detail panel with visual timeline and glossary
  tooltips, freshness caveats and "view on official portal" links throughout.

## Quick start

```bash
npm install
npm run seed     # loads ~60 fictional demo applications so the app runs offline
npm run dev      # server on :3001, web on :5173 (Vite proxies /api)
```

Production: `npm run build && npm start` — the server serves the built SPA on
one port.

Tests: `npm test` (normalisation, classifier, search/filter/fuzzy behaviour).

## Real data

`npm run ingest` pulls metadata for the five authorities from the **National
Planning Applications** ArcGIS Feature Service (DHLGH, CC-BY 4.0) — paginated,
rate-limited, idempotent upserts. Configure with:

- `PLANVIEW_ARCGIS_URL` — override the service layer URL
- `PLANVIEW_INGEST_SINCE` — earliest received date (default `2019-01-01`)
- `PLANVIEW_DB` / `PLANVIEW_DATA_DIR` — database location

> **Note:** the build sandbox's network policy blocked `arcgis.com`, so the
> live field names could not be verified during development. They follow the
> published layer schema and are centralised in
> `server/src/ingest/arcgis.ts` (`FIELD_MAP`) — check them once against the
> live service (`curl "<SERVICE_URL>?f=json"`) and adjust in one place if
> needed. The seed fixture (`npm run seed`) is clearly-fictional demo data.

## What's deliberately deferred (per PRD phasing)

- **Phase 0 spike** — per-council document access mode (embed / fetch+cache /
  deep-link only) still needs the feasibility work and council engagement the
  PRD calls for. Until then documents are deep-linked (F4.7), and the
  `documents` table + `access_mode` enum are ready for the outcome.
- **Phase 2** — in-place PDF/image viewer, OCR, download-all.
- **Phase 3** — accounts, saved searches, alerts.
- Council boundary overlay (F2.6) — needs a boundary dataset ingested.

## Data & attribution

Contains Irish Public Sector Data (Department of Housing, Local Government and
Heritage) licensed under CC-BY 4.0. This is a viewer over public register
data; the local authority registers remain the authoritative source, and the
UI says so on every application. Withheld/redacted content flags from source
are respected and never bypassed.
