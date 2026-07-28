# Backlog

- **Per-application link previews + SEO metadata (parked 2026-07-27 — decision
  needed first).** An open application is now a real URL
  (`/application/{council}/{reference}`), but every one of them shares the
  static `index.html`, so a link pasted into WhatsApp/Slack/LinkedIn shows a
  generic PlanView card and Google sees one title for the whole site. Crawlers
  don't run JS, so the address and status — which only exist after hydration —
  are invisible to them.
  **The job:** route `/application/*` through the API function in
  `.vercel/output/config.json` (copy `index.html` into the `.func` at build
  time), look the record up in the in-memory bundle, and inject `<title>`,
  `og:title` (address), `og:description` (status · type · council · decision
  date), `og:url` and `twitter:card` into the head before serving. The SPA
  hydrates over it unchanged. Optionally an `og:image` — a Mapbox static map of
  the site, reusing the aerial-thumbnail URL builder — which is what actually
  makes a card get clicked. Care: HTML-escape the address (council free text),
  serve identical HTML to people and crawlers (no cloaking), cache hard with
  `s-maxage` since routing HTML through a function is slower than static, and
  fall through to the plain shell on an unknown reference. Same work unlocks
  useful search titles; `sitemap.xml`/`robots.txt` follow. ~half a day, plus a
  couple of hours for the image.
  **Open question before building:** this makes a PlanView page for every
  private home address publicly indexable. It's all public register data and
  competitors already index it, but someone's address could then surface in a
  Google search — a deliberate choice, not a technical default. Decide the
  indexing policy (all / none / `noindex` on domestic) before shipping.

- **Street View picks side/back streets (parked 2026-07-24).** Our coordinate is
  the *site centroid* (eplanning's grid reference / the national feed's point),
  not the building frontage, and Google returns the panorama **nearest the point
  asked for** — so it often lands on a laneway or side road, sometimes years
  older than the frontage coverage, and clearly not the property. Already done:
  `source=outdoor`, a heading aimed from the pano back at the site, and
  `fov=110` (`PropertyMedia` in `web/src/components/DetailPanel.tsx`). A probe
  of a 35 m ring that preferred the *most recent* panorama was tried and
  **reverted** — "newest" is no proxy for "front", and it sometimes picked a
  pano a street away, which reads worse than a near one facing the wrong way.
  The real fix is to anchor on the **street named in the address**: look that road up (OSM
  Overpass/Nominatim), take the point on it nearest the property, and ask Google
  for a panorama there. Caveats: only works where the address has a street name
  (many Kildare addresses are townlands), road-name matching is messy
  (abbreviations, Irish/English variants, duplicates within a county), and the
  lookup is too slow/rate-limited for runtime — it wants resolving at build time
  and baking into the bundle. Consider also hiding the tile when the chosen pano
  is very old or far away, rather than showing something misleading.

- **Split decisions — verify + AI summary (parked 2026-07-22).** A `split`
  canonical status (pink **S**) now exists and is detected from decision text
  containing both grant and refuse, or a "Split Decision" status
  (`server/src/normalize.ts`). To finish: (1) confirm detection on real data —
  e.g. REF2124, via the `/api/applications/<id>` JSON (`status_raw`, `decision`,
  `decision_raw`) — widen the pattern if the wording differs; (2) an **AI
  summary of the split** spelling out what was granted vs refused — agile from
  the `/conditions` items (C = granted-part conditions, R = refused-part
  reasons), Kildare from the scanned decision-order PDF; (3) the detail panel's
  `isRefusal` check is `refused`-only, so a split won't surface refusal reasons
  yet — generalise it.

- **Google Maps API key for inline property imagery.** The detail sheet
  already renders Street View + aerial thumbnails when `VITE_GOOGLE_MAPS_KEY`
  is set at build time. To activate: Google Cloud project with billing →
  enable *Street View Static API* + *Maps Static API* → create a key
  restricted to the Vercel domain and those two APIs → add as
  `VITE_GOOGLE_MAPS_KEY` in Vercel env vars → redeploy. ($200/month free
  credit ≈ ~25k image loads; metadata checks are free.)

- **DLR (solved 2026-07).** Dún Laoghaire-Rathdown retired SwiftLG and moved
  to Agile Applications (x-client DLR, slug dunlaoghaire) — applicant/agent,
  conditions, and document listings/downloads all work through the same
  integration as the other agile councils. planning.dlrcoco.ie now hosts an
  unrelated APEX housing app.

- **Agile API notes (solved).** Base `planningapi.agileapplications.ie/api`,
  tenant headers x-client (SD / DCC / FG) + x-product CITIZENPORTAL +
  x-service PA, captured from a browser session. Useful endpoints:
  `/application/search?query={ref}` and `/application/{id}` (rich detail,
  incl. applicant + agent). `/application/{id}/document` exists but returns
  [] for all three Irish councils — documents come from each council's own
  DMS instead, loaded in an iframe by the portal SPA.

- **Documents for Dublin City + Fingal.** South Dublin's DMS is solved
  (plain HTML at planning.southdublin.ie/Home/Documents?regref={ref},
  direct-PDF links — wired into the scanned-files listing + proxy). Fingal's
  portal config says DMS=SHAREPOINT and Dublin City's DMS is unknown; both
  need their iframe DMS URL captured from a browser session on a
  documents-bearing application, same way South Dublin's was found.

- **Kildare submissions list on the detail sheet.** eplanning pages carry a
  hidden "Submitter Details" popup (contact name, recorded/acknowledged
  dates) on applications with submissions — same page the parties backfill
  already fetches. Note statutory consultees (e.g. Uisce Éireann) appear
  alongside genuine third-party objectors, so show names, not just a count.

- **Compare similar nearby applications.** With conditions + refusal reasons
  now available (agile councils), build a "what happened nearby" view: find
  applications near a location for similar work (extension, attic
  conversion, new dwelling…), show grant/refusal outcomes, common grant
  conditions, and recurring refusal reasons — so someone planning work can
  see what the council actually decided on comparable proposals. Needs the
  conditions endpoint only for agile councils; Kildare/DLR outcomes are in
  the bulk data but not their conditions text.

- **Zoning as a map overlay.** The detail sheet now shows zoning via a live
  point query against the national GZT layer (MyPlan / DHLGH,
  services.arcgis.com/NzlPQPKn5QF9v2US → GZT_Current_Plan). Drawing zones on
  the map itself is a separate job — the layer is ~83k polygons nationally,
  so it wants the hosted vector tile endpoint (or a bbox-filtered GeoJSON
  fetch at high zoom only) plus the official COLOUR field for fills.

- **"Appealed" filter as an area-level contested signal.** Appeal fields are
  in the bulk dataset (unlike objections); a filter chip would let users see
  contested applications across the map.

- **Scheduled redeploy for data freshness.** The Vercel bundle only refreshes
  on deploy; a weekly cron (Vercel deploy hook) would keep the register data
  current without code changes.

- **Shareable standalone property page (parked — flesh out the "why" first).**
  Add a small open-in-new-tab icon to the top corner of the detail slide-over
  that opens the same property as its own standalone route
  (e.g. `/application/:id` or `/property/:slug`), keeping the panel/tab
  behaviour unchanged. The standalone page fetches the *full* data set (not
  the summary payload the panel loads): full description, conditions, refusal
  reasons, appeal/ABP outcome, all applications at the address, commencement
  notices, PPR sales, zoning + flood. Value is distribution — a link that
  forwards between developer/architect/solicitor/vendor, and an indexable SEO
  surface Planify (paywalled) can't have. Parked until the use case is
  decided; likely the on-screen twin of the property report below.

- **Property planning report (paper/PDF + shareable microsite).** A rich,
  readable per-property/site report — the paid deliverable that beats
  Planify's tables-of-counts "pre-planning report". A V1 sample layout exists
  (artifact, 2026-07-21): masthead, planning-history timeline, "was it built",
  sale history, constraints, written summary, nearby precedent, sources —
  presentation validated as strong. Buyers skew traditional (solicitors,
  agents, older property people), so it must read like a professional
  document, not a dashboard. Delivered as a print-clean PDF and/or the
  standalone microsite above. Monetisable per-report (solicitor/agent) as
  well as in-app.

  **Open question — the job of the report is not yet defined.** Needs real
  customer conversations before build; don't over-invest until the use case
  is pinned. Design implication already clear: *most properties have little
  or no planning history*, so the report cannot lean on the applications
  timeline alone — the sections that stand on every property are the ones to
  lead with.

  What carries every property (confirmed useful): "was it built" +
  commencement status, PPR sale history, and **nearby precedent** (rated very
  interesting). Where the biggest untapped depth is: the **spatial context /
  development-plan layer**, beyond the flood + zoning + ACA we already have.
  Candidates to explore — proximity to and designation of adjoining land
  (green belt, zoned open space / amenity, strategic/development land),
  protected areas (SAC/SPA/NHA, coastal), local amenities (schools, parks,
  transport), development-plan objectives/overlays affecting the site or its
  boundary, and Record of Protected Structures / ACA extent. Motivating case:
  an owner planning an extension who fears encroaching on an adjoining
  green/amenity zone — the report should answer "what is that land beside me,
  and what does the plan intend for it?". Much of this is available from the
  same MyPlan/DHLGH + council development-plan GIS layers we already touch.

  Full-content draft (for when built): property identity + map/aerial/Street
  View (with capture date) + zoning + development-plan context; complete
  planning history (full description, decision, AI summary, conditions,
  refusal reasons, ABP appeal), flagged for refusals/appeals/live/withdrawn/
  extensions; commencement notices; PPR sales; constraints/spatial-context
  layer above; a *written narrative* (the bit Planify skips); nearby-precedent
  comps; sources + methodology + disclaimer ("evidence & precedent", not
  advice — see liability note).

- **Aggregate views for commencements + PPR (not just per-property fields).**
  Commencement-notice and Property Price Register data are already connected
  but only surfaced as fields on a single application. Consider area-level
  displays: commencement activity / build-out rates by area, PPR price trends
  overlaid on the map or in the agent's aggregates — "which permissions are
  actually being built, and what did things sell for round here."

- **Eircode is ~2% populated at source.** Checked 2026-07-20: only 1,839 of
  96,587 national-dataset applications received since 2024 have
  DevelopmentPostcode filled — councils don't key it in, though it usually
  appears on the application form PDF. The Property information row stays
  (shows "No information available"). Options to backfill: the agile detail
  response (check whether any tenant carries an eircode field), AI extraction
  from the application-form document we already fetch, or reverse-geocoding
  coordinates (needs a licensed Eircode/autoaddress API — no free lookup).

## Accounts follow-ups (from 2026-07-24 accounts build)

- **Area-watch alerts (v2):** "anything new near X" — watch a location/radius
  for new applications and commencements, not just explicitly saved apps.
- **In-app notification feed (v2):** bell with red dot, chronological feed of
  events across saves; possibly AI summaries of what changed.
- **Rate limiting beyond the live-token cap:** per-IP throttle on
  /api/auth/request-link and the write endpoints.
- **Kildare live status in cron:** the eplanning list parser isn't wired into
  the cron's live fetch, so Kildare relies on the national dataset + bundle.
- **Remove-from-list UI:** list membership can be added in the save popover
  but there's no affordance to remove a save from one list without unsaving.
- **Token/session GC:** expired auth_tokens and sessions rows accumulate;
  add cleanup to the daily cron.
- **Cookie-parse hardening:** wrap cookie parsing in try/catch (malformed
  header currently 500s instead of treating as signed-out).
- **Save PATCH null type:** accountApi.updateSave accepts nulls the backend
  ignores; tighten the type.
- **Accessibility:** aria-pressed on save stars; list rename commits on
  Enter but should also handle Escape-to-cancel consistently.
- **Dashboard map fit-to-pins:** map view opens at default viewport instead
  of fitting saved pins.
- **Pre-existing:** MapView stale onSelect closure; agent request abort not
  wired through.

## Map layers (from 2026-07-26 open-data research)

Shipped from that research: natural heritage (SAC/SPA/NHA/pNHA merged from
NPWS `services-eu1.arcgis.com/Jhij7i46ouO8Cc0N/.../NPWSDesignatedAreas`,
sub-layers 0=SPA 1=pNHA 2=NHA 3=SAC) and Zones of Archaeological
Notification (`services-eu1.arcgis.com/HyjXgkV6KGMSF3jt/.../SMRZoneOpenData`).
ACAs are a baked static file (docs/ACA_DATA.md). Still to build:

- **NIAH buildings layer.** National Inventory of Architectural Heritage —
  ~50k surveyed buildings with build date, description, original/current
  use and rating; the state inventory behind most RPS entries. Verified
  live endpoint (same DHLGH org as the SMR layers):
  `services-eu1.arcgis.com/HyjXgkV6KGMSF3jt/.../NIAHBuildingsOpenData/FeatureServer/0`
  — point data, so it wants a dot style and a higher min-zoom (~15) rather
  than the polygon-fill pattern; rich popup content (NAME, ORIGINAL_TYPE,
  IN_USE_AS_TYPE, DESCRIPTION, REG_NO → buildingsofireland.ie).
- **Recorded monuments (SMR points).** Pairs with the archaeology zones —
  says *what* the monument is. Verified live:
  `services-eu1.arcgis.com/HyjXgkV6KGMSF3jt/.../SMROpenData/FeatureServer/0`
  (MONUMENT_CLASS, SMRS ref, WEB_NOTES, WEBSITE_LINK deep link). Could
  render only when the zones layer is on, or drive a richer zone popup.
- **Record of Protected Structures (RPS).** The most consulted heritage
  constraint (Section 57), but per-council patchwork like ACAs — no
  national dataset. Fingal has a live FeatureServer
  (`services5.arcgis.com/CI1e5PKQXvJgmJK8/.../Fingal_County_Council_Development_Plan_2017_to_2023_Record_Protected_Structures/FeatureServer/0`);
  DCC/SDCC/DLR/Kildare need the same per-council hunt → bake static, the
  docs/ACA_DATA.md treatment. NIAH above is ~80% of the signal for far
  less work, so do it first.
- **Parked (research said not yet):** airport noise/safety zones
  (Fingal-only, buried in dev-plan appendices), SDZ/LAP boundaries (few
  and stable — better as search facets), TPOs and protected views (no
  consistent open data), GSI geology/landslide + EPA historic landfills
  (real factors for large developments, niche for our domestic-leaning
  audience). Bonus found on the DHLGH org: National Park boundaries,
  Ancient/Long-Established Woodland (ALEW), UNESCO sites.

- **Flood zones layer rebuilt from OPW open data (2026-07).**
  Static GeoJSON baked from NIFM (fluvial) + NCFHM (coastal) shapefiles,
  client-side overlay and point-in-polygon lookup. If the file size
  impacts initial load, convert to PMTiles vector tiles.

## Pre-planner report (shipped v1, 2026-07-26)

Account-gated projects (location + intent) generating immutable printable
reports: designations point queries (zoning/NPWS×4/SMR zones/ACA), NIAH +
SMR points within 250m (first use of those backlog endpoints — the map
layers themselves are still pending), flood point-in-poly on the baked
OPW file, GSI groundwater vulnerability
(`gsi.geodata.gov.ie/.../IE_GSI_Groundwater_Vulnerability_40K_IE26_ITM`),
precedents within 1km with document deep-dives via the agent reading
machinery, area stats, one-shot Haiku considerations narrative.

- **Radon**: the EPA ArcGIS host (`gis.epa.ie/arcgis`) is not publicly
  reachable (probed 2026-07-26) — the section permanently reads "couldn't
  be checked" with a pointer to epa.ie. Revisit if EPA re-hosts.
- **v1 out of scope**: re-run diffing ("what changed since last report"),
  share links / PDF export beyond the print stylesheet, feeding a report
  into the AI chat as context, geocoding beyond register matches + map pin.
- **Neon migration**: sensitive env vars can't be pulled locally, so the
  preplan tables are created by `ensureSchema()` in api/preplan/routes.mjs
  on first use; scripts/migrate-accounts.mjs carries the same statements.

## Agile detail harvest → dataset enrichment (backlogged 2026-07-27)

The agile portals' per-application detail (GET /application/{id}) carries
fields the national dataset lacks or truncates: fullProposal, case officer
(officerName), Eircode (postcode), applicant/agent names, live status and
decision. Today we fetch it lazily per detail-panel open (/enrich) and
backfill a few columns. Instead, run a regular scraping job across all
applications for the four agile councils (DLR, Fingal, Dublin City, South
Dublin) — low thousands per authority, so one polite nightly/weekly sweep
is small.

- Store officer_name as a first-class column → enables "which officers
  grant vs refuse" style analytics and an officer facet/search.
- Replace truncated descriptions wholesale (kills the Fingal-style AI
  summary failures at the root instead of per-open).
- Backfill Eircodes en masse (national dataset ~2% populated).
- Respect the tenants: throttle, resume, cache agile ids (resolveAgileId
  is the slow step); reuse pickDescription/pickOfficer/pickAgileDecision
  from server/src/agile.ts.
- Watch decision-flip safety: the ingest write path must use the same
  CORRECTABLE_BAKED/TERMINAL_LIVE rules as /enrich so a stale portal read
  never clobbers a fresh national decision.
