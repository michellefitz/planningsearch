# PRD — Unified Irish Planning Permission Viewer

**Working title:** *PlanView* (placeholder)
**Doc type:** Product Requirements Document (developer build spec)
**Version:** 0.1 (draft for build scoping)
**Date:** 18 July 2026
**Owner:** Michelle (michelle@sideforge.dev)
**Scope of v1:** Kildare County Council + the four Dublin local authorities (Dublin City, Dún Laoghaire-Rathdown, Fingal, South Dublin). Focus on domestic planning, though the data is not separated by domestic/commercial at source.

---

## 1. Summary

Looking up planning permission in Ireland is painful because every local authority runs a different back-end system with a different search UI, a separately bolted-on map viewer, and a clunky "view scanned files" flow that opens documents in new windows one page-image at a time. A resident checking whether their neighbour got permission for an extension, or an agent doing due diligence on a site, has to (a) know which council covers the address, (b) learn that council's particular portal, and (c) fight a dated interface to actually read the file.

This product is a single, modern, map-first interface over the planning registers of the five target authorities. One search box, one map, one clean application view, one good document reader. The user should never need to know which council — or which vendor system — sits behind the address they care about.

**The hard problem is not the UI — it is document access.** Structured application metadata (reference, address, applicant, status, dates, location) is available nationally as open data. The scanned files (drawings, forms, planners' reports, decision orders) are not: they live behind each council's own portal. The architecture below treats document access as the central design constraint, not an afterthought.

---

## 2. Problem statement

### 2.1 The fragmentation is structural, not cosmetic

The five target authorities run **four different back-end planning systems**, each with its own separate map layer:

| Authority | Register / search system | Vendor family | Map viewer (separate tool) |
|---|---|---|---|
| Dublin City Council | planning.agileapplications.ie/dublincity | Agile Applications | mapzone.dublincity.ie (MapZone) |
| Fingal County Council | planning.agileapplications.ie/fingal | Agile Applications | ArcGIS web app viewer |
| Dún Laoghaire-Rathdown | planning.dlrcoco.ie/swiftlg (SwiftLG APAS) | Idox SwiftLG | separate GIS |
| South Dublin | planning.southdublin.ie / National Online Planning Portal | Local Government Ireland (localgov.ie) | separate GIS |
| Kildare | eplanning.ie/KildareCC | eplanning.ie | webgeo.kildarecoco.ie (WebGeo GIS) |

So even the two councils the user originally named (Kildare and "Dublin") sit on entirely different vendor stacks. This is the core justification for the product: the pain is not one bad website, it is the absence of any layer that unifies them.

### 2.2 What specifically is broken (user-facing)

- **You must pick the council first.** There is no cross-authority search. If you are on a boundary (e.g. Lucan vs Leixlip, South Dublin vs Kildare) you may not know which register to check.
- **Search is literal and unforgiving.** Reference-number matching with wildcards (`*`), exact-ish location strings, "enter `*surname`" conventions. No fuzzy address search, no "search near me," no natural-language tolerance.
- **Map and register are divorced.** The map tells you *where*; to read the file you jump to a different tool and re-find the application.
- **The application view is a wall of tabs.** Details, contacts, dates, further information, appeals, decisions — spread across tabs, dense tables, and abbreviations.
- **Documents are the worst part.** "View Scanned Files" opens documents in new windows, often as multi-page scanned image sets, one click per item, no in-place viewer, no thumbnails, no combined PDF, poor mobile behaviour, no text search inside documents.
- **Data-protection redaction is inconsistent** and handled differently per council, and some content is simply not online ("contact the public counter").

### 2.3 Who feels this

Homeowners and neighbours checking domestic applications; self-builders and people planning extensions; architects, engineers and planning agents; estate agents and conveyancing solicitors doing due diligence; journalists and community/residents' groups; and objectors preparing observations within the statutory window.

---

## 3. Goals and non-goals

### 3.1 Goals (v1)

1. **One search across all five authorities** — by address, area, reference, applicant name, or keyword — with fuzzy/typo tolerance.
2. **Map-first discovery** — see applications as pins/polygons on a single map, filter by status/date/type, click a pin to open the application.
3. **A clear, single-page application view** — the whole story of an application (what, where, who, status, timeline, decision) without tabs or jargon.
4. **A genuinely good document reader** — all files for an application in one in-place viewer: thumbnails, continuous scroll, zoom, download-all, and text search where OCR is possible.
5. **Mobile-first and accessible** — WCAG 2.1 AA; usable one-handed on a phone standing outside a site.

### 3.2 Non-goals (v1)

- **Not a submission/lodgement system.** We do not replace the councils' application-submission portals or take payments. Read/discovery only. (Submitting *observations* is a possible later phase — see §9.)
- **Not legal advice.** We present the register faithfully; we do not interpret planning law or predict outcomes.
- **No national coverage in v1.** Five authorities only. The architecture must not assume five forever, but we do not build the other 26 now.
- **Not a replacement of the statutory register.** We are a viewer over public data; the councils remain the authoritative source, and we say so.

### 3.3 Guardrail / anti-goal

Do not let the map or "AI summary" features imply a legal status the register does not state. Faithfulness to source beats cleverness.

---

## 4. Users and jobs-to-be-done

| Persona | Primary job | Success looks like |
|---|---|---|
| **Neighbour / resident** | "Did the house beside me get permission, and for what?" | Finds it by address in <30s, understands status and what was approved, reads the drawings on their phone. |
| **Self-builder / extender** | "What have people near me been granted, and what got refused?" | Browses the map around their area, filters to granted domestic apps, opens precedents and drawings. |
| **Agent / architect** | "Full history and documents for this site, fast." | Pulls every application on a site, sorts by date, downloads the full file set as one PDF. |
| **Solicitor / estate agent** | "Due diligence: any live or refused apps here?" | Searches an address, sees complete list across authorities, exports a summary. |
| **Objector / community group** | "Is there a live application, and when does the observation window close?" | Finds live apps, sees the statutory dates clearly, sets an alert. |

Cross-cutting need: **saved searches and alerts** ("tell me about new applications within 500m of this address").

---

## 5. Data landscape (the crux)

### 5.1 Two tiers of data, very different availability

**Tier 1 — Structured metadata (available, open).**
The **National Planning Applications** database (Department of Housing, Local Government and Heritage) publishes spatial + tabular data for participating local authorities via an **ArcGIS REST Feature Service**, under CC-BY 4.0, covering applications since 2012. It includes application points/polygons and register fields (reference, address, status, dates, development description). Individual councils also publish their own datasets (e.g. Kildare on data.kildarecoco.ie; Dublin authorities via data.smartdublin.ie / the PSB data catalogue). This is enough to power **search and map** for all five authorities without scraping.

- National service (ArcGIS REST): `services.arcgis.com/NzlPQPKn5QF9v2US/arcgis/rest/services/IrishPlanningApplications/FeatureServer`
- National viewer / open data: `data-housinggovie.opendata.arcgis.com`
- Formats available: GeoServices REST, GeoJSON, CSV, XLSX, GPKG, KML, GDB.

**Tier 2 — The documents (the hard part, not open).**
Scanned files — application forms, site location maps, drawings, further-information submissions, planners' reports, decision orders, appeal documents — are **not** in the open datasets. Each is only reachable through the council's own portal:

- Agile authorities (Dublin City, Fingal): documents under **"View Scanned Files"** in each application; councils are obliged to have files online within ~5 working days.
- DLR: files via the **SwiftLG APAS** document tab.
- South Dublin: files via the **localgov.ie national portal** application view.
- Kildare: files via **eplanning.ie** / the WebGeo planning enquiry, with the council noting **some content is withheld for data-protection reasons** and directing users to the public counter for full contents.

**Implication for architecture:** metadata ingestion is a solved, clean API problem. Documents require a per-system access strategy (deep-link, fetch, or — where permitted — cache), and must degrade gracefully to "open on the council portal" where we cannot retrieve them. See §7.3.

### 5.2 Access strategy per system (v1 build targets)

| System | Metadata source | Document access approach (v1) |
|---|---|---|
| National DB (all five) | ArcGIS REST Feature Service | n/a (metadata only) |
| Agile (Dublin City, Fingal) | National DB + Agile public pages | Deep-link to application; investigate stable document URLs for in-app embed |
| Idox SwiftLG (DLR) | National DB + SwiftLG APAS | Deep-link to `wphappcriteria` / document tab; SwiftLG has known URL patterns |
| localgov.ie (South Dublin) | National DB + national portal | Deep-link to national portal application view |
| eplanning.ie (Kildare) | National DB + eplanning + WebGeo | Deep-link to eplanning application; respect withheld-content flags |

**Decision required before build:** for each system, confirm whether documents can be (a) embedded in our viewer via stable URLs, (b) fetched and cached with attribution, or (c) only deep-linked. This is the single biggest determinant of how good the document experience can be, and it should be resolved per-council in a spike (§9 Phase 0) — including a direct conversation with each authority / the DHLGH about permitted reuse.

### 5.3 Refresh & freshness

- Metadata: scheduled pull from the national service on a fixed cadence (target: daily; validate the source's own update frequency). Store last-synced timestamps per authority and surface data freshness in the UI.
- New-application detection drives alerts (§6.6).
- Never present cached data as live for statutory-window purposes without a visible "as of {date}, confirm on council portal" caveat.

---

## 6. Functional requirements

Requirements use **MUST / SHOULD / MAY**. IDs (F1.x) are for traceability.

### 6.1 Search (F1)

- **F1.1 (MUST)** Single search input covering all five authorities simultaneously.
- **F1.2 (MUST)** Support query types: full/partial **address**, **townland/area/eircode**, **planning reference** (with and without wildcards), **applicant name**, and **free-text** in the development description.
- **F1.3 (MUST)** Fuzzy matching and typo tolerance on address/location (e.g. "Maynooth", "manooth" both work). Autocomplete suggestions as the user types.
- **F1.4 (MUST)** "Search near me" using device geolocation; "search this area" tied to current map viewport.
- **F1.5 (MUST)** Filters: authority, status (granted / refused / pending / withdrawn / invalid / further-info requested), decision date range, received date range, application type, and a **domestic-only heuristic** (see §6.7).
- **F1.6 (SHOULD)** Sort by relevance, date received, decision date, distance.
- **F1.7 (SHOULD)** Results render simultaneously as a **list and on the map**, kept in sync (hovering a result highlights its pin).
- **F1.8 (MAY)** Natural-language query parsing ("extensions refused in Naas in 2024").

### 6.2 Map (F2)

- **F2.1 (MUST)** Single slippy map (vector tiles) covering all five authorities, with application locations as points and site outlines as polygons where available.
- **F2.2 (MUST)** Clustering at low zoom; individual pins at high zoom. Colour-coded by status with an accessible palette (not colour-alone — use shape/icon too).
- **F2.3 (MUST)** Click a pin → open the application detail view (§6.3) in a side panel without losing map context.
- **F2.4 (MUST)** Layer toggles for status and application age; a legend.
- **F2.5 (SHOULD)** Draw-a-radius / draw-a-polygon to query all applications within an area.
- **F2.6 (SHOULD)** Show council boundaries so users understand which authority an address falls under (directly answers the "which council?" confusion).
- **F2.7 (MAY)** Satellite/aerial base layer toggle.

### 6.3 Application detail view (F3)

Replace the multi-tab layout with **one scrollable page** organised as a narrative.

- **F3.1 (MUST)** Header: plain-language development description, address, authority, status badge, key dates.
- **F3.2 (MUST)** **Visual timeline** of the application: received → validated → (further info requested/received) → decision due → decided → (appeal to An Bord Pleanála) → final grant/refusal. Statutory dates (e.g. observation deadline, decision-due date) called out prominently.
- **F3.3 (MUST)** Structured facts panel: reference, applicant, agent, application type, decision, decision date, conditions count. Jargon and abbreviations expanded via inline tooltips/glossary.
- **F3.4 (MUST)** Location mini-map showing the site.
- **F3.5 (MUST)** Documents section (§6.4) inline on the same page.
- **F3.6 (SHOULD)** Related applications on the same site/address, linked.
- **F3.7 (SHOULD)** Optional AI-generated plain-English summary of the development, clearly labelled as generated and secondary to the official description. Must not assert a status the register does not state.
- **F3.8 (MUST)** Persistent "View on official {council} portal" link and a data-freshness/"authoritative source" caveat.

### 6.4 Document viewer (F4) — the flagship feature

- **F4.1 (MUST)** List **all** files for an application in one place with human-readable names, type, and page count where known (drawings, forms, reports, decision order, etc.).
- **F4.2 (MUST)** **In-place viewer**: open any document without a new browser window. Thumbnail rail, continuous scroll, pinch/scroll zoom, rotate, page jump.
- **F4.3 (MUST)** Where a document is a multi-page scanned image set, present it as a **single continuous document**, not one-click-per-page.
- **F4.4 (SHOULD)** **Download**: single file, or **"download all as one combined PDF."**
- **F4.5 (SHOULD)** **OCR** scanned documents to enable in-document text search and copyable text; flag when OCR confidence is low.
- **F4.6 (SHOULD)** Deep-link to a specific document/page (shareable URL).
- **F4.7 (MUST)** Graceful degradation: if we cannot retrieve/embed a file (access constraint), show the file list and a clear deep-link to the council's viewer rather than a broken embed.
- **F4.8 (MUST)** Respect withheld/redacted content flags; never attempt to surface content a council has withheld for data-protection reasons.

### 6.5 Saved items & tracking (F5)

- **F5.1 (SHOULD)** Save an application to a personal list.
- **F5.2 (SHOULD)** Save a search (query + filters + map area).
- **F5.3 (MAY)** Share an application or search via link.

### 6.6 Alerts & notifications (F6)

- **F6.1 (SHOULD)** Alert on **new applications** within a saved area/address.
- **F6.2 (SHOULD)** Alert on **status changes** to a saved application (e.g. decision made, further info requested).
- **F6.3 (SHOULD)** Delivery via email; **MAY** push/web-push.
- **F6.4 (MUST, if alerts ship)** Alerts must state the data-as-of time and direct users to the council portal for anything time-critical (observation windows), because we cannot guarantee real-time parity.

### 6.7 Domestic-planning focus (F7)

Source data does not cleanly separate domestic from commercial. v1 approach:

- **F7.1 (SHOULD)** Heuristic classifier tagging likely-domestic applications from the development description (keywords: extension, dormer, attic conversion, garage, dwelling, porch, etc.) and application type/scale.
- **F7.2 (SHOULD)** A "domestic only" filter built on F7.1, clearly labelled as a best-effort filter, not an official category.
- **F7.3 (MAY)** Improve the classifier over time with user feedback ("is this domestic?").

### 6.8 Accessibility & mobile (F8)

- **F8.1 (MUST)** WCAG 2.1 AA across search, map, detail, and document viewer.
- **F8.2 (MUST)** Mobile-first responsive layouts; the document viewer must be genuinely usable on a phone.
- **F8.3 (MUST)** Keyboard-navigable; screen-reader labels on map controls and document controls; status conveyed by more than colour.

---

## 7. System architecture (indicative)

### 7.1 Shape

A classic ingest → normalise → serve pipeline with a document-access layer bolted on the side.

```
[National ArcGIS Feature Service] ─┐
[Council open datasets] ───────────┼─> Ingestion workers ─> Normaliser ─> Canonical store (Postgres + PostGIS)
[Per-council portals (docs)] ──────┘                                          │
                                                                              ├─> Search index (typo-tolerant: Meilisearch/Typesense/OpenSearch)
                                                                              ├─> Vector tile service (map)
                                                                              └─> API (GraphQL/REST) ─> Web app (map-first SPA + doc viewer)
                                     [Document access service] <──────────────┘
                                     (deep-link | fetch+cache | OCR)  ─> Object storage (S3-compatible) + OCR/search
```

### 7.2 Ingestion & normalisation

- **Metadata:** scheduled workers pull from the national ArcGIS Feature Service (primary) and per-council datasets (reconciliation/fill-gaps). Map each source's fields onto a **canonical schema** (§8). Store `authority`, `source_system`, `source_url`, `last_synced`.
- **Dedup / identity:** national DB may lag or differ from council registers; define a stable key (`authority + planning_reference`) and a reconciliation strategy when sources disagree.
- **Geometry:** store points and site polygons in PostGIS; generate vector tiles for the map.

### 7.3 Document access service (the make-or-break component)

Per source system, implement one of three modes, chosen by the Phase 0 spike (§5.2, §9):

1. **Deep-link only** — we store the document-list metadata and link out to the council viewer. Lowest legal risk, worst UX. This is the guaranteed floor.
2. **Fetch-on-demand + cache** — on first view, retrieve documents from the council portal, cache in object storage, OCR, and serve through our viewer with source attribution. Best UX; requires confirming permitted reuse per council.
3. **Bulk mirror** — pre-fetch document sets. Only if explicitly permitted; heaviest and most sensitive.

The service must isolate each council's quirks (URL patterns, auth, rate limits, session handling) behind a common interface so the front-end viewer is source-agnostic. Respect robots/terms, rate-limit politely, and honour withheld-content flags.

### 7.4 Front-end

- Map-first SPA. Vector-tile map (MapLibre GL or similar). List/map sync. Side-panel detail view.
- Document viewer built on a robust PDF/image renderer (e.g. PDF.js) with a thumbnail rail, continuous scroll, and an OCR text layer.
- Server-side rendering for application detail pages (SEO — people Google "planning permission {address}"; being the good result is a growth channel).

### 7.5 Non-functional requirements

- **Performance:** search results < 500ms p95; map pan/zoom smooth at county scale; first document page visible < 2s when cached.
- **Availability:** the app must not fall over when a council portal is down — cached metadata keeps search/map working; document viewer degrades to deep-link.
- **Scalability:** design the canonical schema and ingestion for N authorities, not 5, even though v1 ships 5.
- **Observability:** per-source ingestion health, document-fetch success rates, staleness dashboards.

---

## 8. Canonical data model (starting point)

```
Authority(id, name, source_system, portal_base_url, gis_url)
Application(
  id, authority_id, planning_reference,
  description, application_type, is_domestic_guess,
  status, received_date, validated_date,
  further_info_requested_date, further_info_received_date,
  decision_due_date, decision, decision_date,
  appeal_status, final_grant_date,
  applicant_name, agent_name,
  address_text, eircode, geom_point, geom_polygon,
  source_url, last_synced
)
Document(
  id, application_id, title, doc_type, page_count,
  access_mode(enum: link|cached), source_url,
  cached_object_key, ocr_status, is_withheld
)
SavedItem(id, user_id, application_id | search_json, created_at)
Alert(id, user_id, type(new|status), area_geom | application_id, channel, active)
```

Notes: `status`, `decision`, and `application_type` need per-council value mapping tables (each system uses different codes/labels). `is_domestic_guess` is heuristic (§6.7), never presented as official.

---

## 9. Phasing / roadmap

**Phase 0 — Feasibility spikes (before committing to full build).**
The whole product's quality hinges on document access. Do these first:
- Confirm national ArcGIS coverage and field completeness for all five authorities.
- For each of the four back-end systems, spike document retrieval: are there stable document URLs? Can we embed/cache, or only deep-link? What are the terms/rate limits?
- Engage each authority / the DHLGH on permitted reuse of documents and attribution.
- Output: a per-council "document access mode" decision that sizes the rest of the build.

**Phase 1 — Search + map + detail (metadata only).**
Cross-authority search (F1), unified map (F2), single-page application view (F3) built purely on open metadata. Documents shown as a list with deep-links out (F4.7 floor). This is shippable, already better than the status quo, and de-risked because it needs no document scraping.

**Phase 2 — The document viewer.**
In-place viewer (F4) for whichever councils Phase 0 cleared for embed/cache; OCR + in-document search; download-all-as-PDF. Deep-link fallback for the rest.

**Phase 3 — Accounts, saved searches, alerts.**
F5, F6. New-application and status-change alerts by area/address.

**Phase 4 (optional) — Beyond viewing.**
Observation submission (deep integration with council portals), national expansion beyond the five, An Bord Pleanála appeal data, richer precedents/analytics for professionals.

---

## 10. Success metrics

- **Task success:** % of users who find a target application by address in < 30s (usability testing + funnel).
- **Document engagement:** % of application views where a document is actually opened in-app (vs bounce to council portal).
- **Cross-authority usage:** searches that return results from >1 authority (proof the unification matters).
- **Return/alert:** saved searches and alert opt-ins per active user.
- **SEO reach:** organic sessions landing on application detail pages.
- **North-star candidate:** weekly successful "find-and-read" journeys (search → open application → open a document).

---

## 11. Risks, constraints & open questions

**Highest risk — document access.** If every council ends up "deep-link only," the flagship feature (F4) collapses to a nicer index over the same old viewers. Mitigation: Phase 0 spike + direct engagement with authorities before over-investing; ship Phase 1 value regardless.

**Data protection / GDPR.** Applicant names, addresses, and drawings are personal data. Councils already withhold some content and redact inconsistently. We must (a) never surface withheld content, (b) have a lawful basis and a clear privacy position for republishing public-register data, (c) provide a takedown/rectification route, and (d) consider `noindex` on sensitive fields even while pages are otherwise SEO-friendly. **Get legal advice before Phase 2.**

**Source reliability & terms of use.** Portals change, rate-limit, or block. Fetching/caching must respect each site's terms; national open data is CC-BY (attribution required). Build resilient ingestion and don't hammer council servers.

**Freshness vs statutory reliance.** People may rely on us for observation deadlines. We must never be the authoritative clock — always show data-as-of and defer to the council portal for time-critical actions.

**Domestic/commercial split is not clean.** F7 is a heuristic; set expectations accordingly.

**"Dublin" ≠ one council.** v1 deliberately covers four Dublin authorities + Kildare; boundary UX (F2.6) matters so users trust coverage.

**Open questions for the user / stakeholders:**
1. Business model — free public good, freemium (pro tools for agents/solicitors), or grant/council-funded? This shapes accounts, exports, and API decisions.
2. Is submitting observations in scope eventually, or strictly a viewer?
3. Appetite for engaging councils/DHLGH directly to unlock document reuse (materially changes what's buildable)?
4. Brand/product name and whether this is positioned as civic-tech, a commercial tool, or both.

---

## 12. Appendix — source systems referenced

- **National Planning Applications** (DHLGH) — ArcGIS REST Feature Service, CC-BY 4.0, applications since 2012. `data.gov.ie/dataset/national-planning-applications`; `data-housinggovie.opendata.arcgis.com`.
- **Kildare** — `eplanning.ie/KildareCC`, `webgeo.kildarecoco.ie/planningenquiry`, dataset on `data.kildarecoco.ie`. Council notes some content withheld for data protection.
- **Dublin City** — `planning.agileapplications.ie/dublincity`, map `mapzone.dublincity.ie`. Applications from 2005 online; files normally online within ~10 working days.
- **Fingal** — `planning.agileapplications.ie/fingal`, ArcGIS map viewer.
- **Dún Laoghaire-Rathdown** — SwiftLG APAS (`planning.dlrcoco.ie/swiftlg`).
- **South Dublin** — `planning.southdublin.ie` / National Online Planning Portal (`planning.localgov.ie`).
- Dublin-region open data hub: `data.smartdublin.ie`.

*Structured metadata for all five is reachable via open data; scanned files are only reachable through each council's own portal. This asymmetry is the defining constraint of the build.*
