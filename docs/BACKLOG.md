# Backlog

## Round-2 persona review (2026-07-28 evening) — post-data-deepening

Same three personas re-ran after the 2012+ backfill, harvest, type/status
taxonomy and report upgrades shipped. Fixed same evening: GRANT/REFUSE
CERTIFICATE OF EXEMPTION misclassifying as granted (169 apps). New findings,
by urgency:

- **Map payload regression (P0).** `/api/map/applications` ignores `limit`
  and now returns all ~94k geocoded rows — 22.7 MB on first load and on
  every search (the old 5-year window was acting as an accidental cap).
  Hostile on mobile. Fix: viewport/zoom-bounded response, server-side
  clustering, or vector tiles (client clustering exists but only after the
  full download).
- **Per-council coverage floors, unstated (P0 for trust).** The national
  feed's depth is uneven: Fingal/DLR/South Dublin reach 2012, **Kildare
  starts 2017, Dublin City 2019**. Nothing states this, so a zero-result
  historical search reads as "no precedent/history exists" — the
  absence-of-evidence trap for both the architect and the solicitor.
  Compute earliest received_date per authority at export, expose in
  /api/meta, and show it in: search empty state, "Other applications at
  this address", the agent system prompt, and the report footer. Also
  investigate: DCC LRD applications (LRD6xxx) appear absent from the feed
  entirely (strategic facet = 0 for DCC); consider a DCC top-up like
  Kildare's.
- **Time-blindness with 14 years of data (P1, one theme, several sites).**
  Search relevance has no recency term (2014 outranks 2024 on "Celbridge
  extension"); the report's "How this area decides" stats and precedent
  scoring are unbounded (blend development-plan eras, precedent rows render
  no dates); decision-date filter exists in the API but not the UI. Fix as
  one pass: recency decay in relevanceScore + selectPrecedents, decision
  date on report precedent rows, window the area stats (last ~5-7y,
  labelled), "Decided between" fields + quick date presets in FiltersBar.
- **Heritage on the property sheet, ungated (P1).** Still absent (round-1
  repeat, now with evidence the code exists: preplan getDesignations/
  getHeritagePoints). Also relabel NIAH in the report — it currently says
  "Protected & listed buildings (NIAH)", but NIAH is a survey, not the
  statutory RPS; that label invites professional reliance errors.
- **Section 5 polish (P1).** Coverage is DLR + South Dublin only (Fingal 1,
  DCC/Kildare 0) — say so when the filter returns zero for a council;
  "Cannot Determine" / "Referred to An Coimisiún Pleanála" deserve a
  distinct label instead of unknown; "S5 REQ AI"/"Request Additional
  Information" decisions should map to further_info.
- **Harvest throughput (P1).** ~300-600 apps/night against ~79k agile apps
  = the better part of a year to fill; newest-first means the archive fills
  last, and truncated pre-harvest descriptions systematically under-retrieve
  old precedents in keyword search. Run a one-off bulk backfill (repeated
  invocations or a longer-running worker), and add a "not yet harvested"
  hint where applicant/agent render as "—".
- **Search haystack (P2).** Add agent_name + eircode to haystackOf once
  harvested (applicant already there); extend the no-fuzzy guard to
  Eircode-shaped queries now (one regex — "W23 Y2W8" currently fuzzy-matches
  a D15 address; "W23" alone false-hits FW23B references).
- **Export (P2, architect's #3).** CSV of search results and saved lists;
  PDF of the report with a methodology/appendix block (sources, dates
  checked, radius); reuse the detail sheet's print provenance footer on the
  report (it currently lacks the "data as of" stamp).
- **Smaller round-2 items (P3):** glossary tooltips dead on touch (abbr
  title) and missing from filter chips; three statuses share the letter D
  (exempt/not_exempt/decided) and exempt-green equals granted-green;
  API silently ignores unknown params (type=part8 returned all 94k rows,
  HTTP 200); report's permanent "Radon: couldn't be checked" row reads as
  breakage; domestic-only row for report rate blocks; per-list digest
  grouping + list CSV; area-watch shape notes — accept polygon/saved-site
  not just radius, reuse the "submissions open until X" string, key
  reminders off decision_due_date + FI clock restarts.
- **Round-2 improvements verified live** (for morale at grooming): 2013
  DLR records serve full conditions, planner's report + decision letter,
  applicant/agent/officer via enrich; same-day freshness; shareable URLs +
  print provenance on the detail sheet ("file-worthy"); refusals
  auto-summarise in plain English; the upgraded report structure "lands"
  for both consumer and professional personas; both professionals now say
  they'd use it today, and the architect would pay €40-60/month as-is.

## Next up (persona review, 2026-07-28)

Three persona reviews (homeowner / architect / conveyancing solicitor) ran
2026-07-28. Fixed same day: search `distance_km` cross-request pollution,
"applicant" dropped from the search placeholder (bundle has no applicant data
yet — restore once the agile harvest bakes it in), digest unsubscribe link +
List-Unsubscribe header. Since shipped: full 2012 backfill, nightly data
refresh, agile detail harvest (2026-07-28, see entry below). Queued next,
in order:

- **Area-watch alerts.** Promoted from "Accounts follow-ups" below — the #1
  ask for the homeowner persona and #3 for the architect. Watch a saved map
  circle/estate/site; digest gains "New in your watched area: [address] —
  submissions open until [date]". Add date-proximity events on the existing
  cron rails while in there: "decision due in 7 days" (decision_due_date is
  ~94% populated), "submissions close Friday", and "commencement notice
  filed" (a completion-undertaking trigger for solicitors mid-conveyance).
- **Place-first search.** All three personas start from a *place*, the
  search starts from register text. Verified failures: "Celbridge" returns a
  Lucan result first (matches "Celbridge Road"); typo "Celbrige" trigram-
  matches Adamstown with no did-you-mean; Eircodes match the ~2%-populated
  register field only. Build: place-level suggest tier (towns/estates/
  streets extracted from addresses → set map bounds, not raw address rows),
  geocode address/Eircode queries with no register hits and fly the map
  there with "Search this area" armed, did-you-mean chip before the trigram
  fallback, and radius-around-a-pin search in the UI (backend `near` +
  agent's radius_km already support it).

## From the persona review (2026-07-28) — to prioritise at next grooming

- **Planning History Report (conveyancing) — this answers the open "job of
  the report" question in the property-report entry below.** The solicitor
  persona's verdict: the pre-planner is "the wrong report written on exactly
  the right machine" — immutable date-stamped snapshots, print CSS, cited
  sources are precisely what a solicitor's file needs, but he has no
  "intent", he has a subject property. Reuse the preplan chassis, drop the
  intent field, assemble: every application at/within 50 m (all statuses,
  with an explicit search-window/coverage statement — the job is proving a
  negative), implementation status per permission (commencement/completion/
  expiry — rated the single most valuable data in the product), conditions +
  decision orders linked, RPS/ACA/flood findings each with dataset name and
  version date, PPR sale history, prepared-for/report-ID block, "not a
  statutory search" wording. ~80% reassembly of existing endpoints. Would
  pay €25–75 per report as a billable outlay. Architect wants the same
  chassis with clean PDF export + own branding.
- **Flood-data licence blocks charging.** OPW NIFM/NCFHM extents are
  CC-BY-NC-ND (scripts/flood/README.md) — resolve (licence, alternative
  source, or drop from paid outputs) before any report is monetised.
- **Statutory heritage in the detail panel.** Property information row has
  zoning/flood/PPR but no ACA or protected-structure check; homeowner and
  solicitor both flagged it. NIAH (used by the pre-planner) is a survey, not
  the statutory RPS — label accordingly. ACA polygons already exist
  (loadStaticGeojson("aca")); RPS is the per-council hunt described under
  Map layers below.
- **Enforcement registers.** Half the solicitor's risk question
  ("unauthorised development?") is structurally unanswerable — at minimum an
  honest "not covered, contact the council" note in the property view;
  ingestion is a roadmap item.
- **PPR three-state display.** "No information available" conflates "no
  recorded sale" with "couldn't match this address" (townland addresses are
  excluded from matching by design). Say which case applies, link
  propertypriceregister.ie for variants.
- **Professional search facets** (architect's #2; converts him to a €30–50/mo
  subscriber): development-TYPE classifier (extension / attic / new
  dwelling(s) / change of use / demolition / shopfront) as filter chips —
  classify descriptions offline at export, extending the is_domestic_guess
  approach; decision-date range + explicit outcome facet (granted / refused /
  granted-on-appeal / refused-on-appeal) — API already supports
  decisionFrom/To, UI doesn't expose it; CSV export of the filtered set
  (signed-in gated); indexed conditions/refusal-reason text search (unique
  in the market — cache conditions at export for decided agile apps).
- **Pre-planner reach + depth.** Show the nav item signed-out (it's the
  strongest signup motivator and currently invisible until signed in);
  rename toward "Check my project"; add a first-class "Might this be
  exempt?" section (40 m² rule etc. — the single most valuable paragraph for
  a homeowner); reverse-geocode dropped pins so the report header shows an
  address, not coordinates; precedent knobs for professionals (radius /
  refusals-only / pick which precedents get deep-dived); a professional mode
  citing plan policy numbers; PDF export beyond window.print().
- **Agent (Ask) improvements.** Tool schemas lack `authority`,
  `application_type`, and decision-date params (the prompt says same-
  authority matters but gives the model no way to filter by it); chat is
  ephemeral — persist conversations per account, "save this answer to
  project X".
- **Detail panel polish.** Raw uppercase decision strings and raw ISO dates
  leak (decisionDate, appeal_decision_date, expiry_date bypass fmtDate);
  zoning "No information available" should distinguish "no zoning
  designation at this point" (rural/unzoned) from "couldn't check" — the
  ReportView copy already does this; tag development-contribution and
  prior-to-occupation conditions (what survives into a sale); print-friendly
  full application record (only .report has @media print today);
  related-applications is exact address-string equality — add a ≤50 m
  radius tier; in-place PDF viewer for the planner's report + decision
  order (the two documents professionals open most; raise the 4 MB proxy
  cap for streaming).
- **Search/UI polish.** Kildare descriptions start mid-sentence ("for the
  conversion of…") — prepend/capitalise at export; glossary tooltips only
  work in the detail sheet and only on hover — extend to filter chips and
  status badges, tap-to-reveal on mobile; "Domestic only" reads planner —
  consider "Houses & home extensions"; first-load strapline + visible
  coverage ("Every planning application in Dublin and Kildare"); sign-in
  card should pitch the pre-planner, not just saves.
- **Coverage statement.** Deferred (data depth is being fixed instead), but
  even post-backfill each surface should say what window/sources it covers —
  the solicitor's completeness question never fully goes away.

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

## Agile detail harvest → dataset enrichment (backlogged 2026-07-27, shipped 2026-07-28)

The agile portals' per-application detail (GET /application/{id}) carries
fields the national dataset lacks or truncates: fullProposal, case officer
(officerName), Eircode (postcode), applicant/agent names, live status and
decision. Previously fetched lazily per detail-panel open (/enrich) only;
now also harvested nightly into Neon and baked into the bundle.

Shipped:

- **Nightly incremental harvest** (api/accounts/harvest.mjs, runs inside
  /api/cron/refresh-data before the deploy-hook POST so each rebuild picks
  up that night's batch). Persists into Neon `agile_enrichment` (PK
  authority_id + planning_reference), caching the resolved agile id — the
  slow resolveAgileId search runs once per application. Priority queue:
  never-harvested newest-received first (old refs predate each council's
  agile migration and won't resolve), then still-live apps stalest-first,
  then resolve failures retried after ~90 days (resolve_failed flag stops
  nightly retries). Concurrency 3, ~150 ms between requests, time-boxed to
  ~200 s of the function's 300 s maxDuration; harvest failure never blocks
  the deploy hook. Route response reports harvested / resolve_failures /
  remaining_estimate. Table also created lazily by ensureSchema() in the
  harvest module; scripts/migrate-accounts.mjs carries the same statements.
- **Build-time merge** (server/src/export-json.ts, live source +
  DATABASE_URL set, best-effort): full_description replaces shorter register
  descriptions (kills the Fingal-style AI summary failures at the root),
  applicant/agent/eircode fill empty register fields, officer_name added as
  a new first-class bundle field, live status applied under the same
  CORRECTABLE_BAKED/TERMINAL_LIVE decision-flip rules as /enrich (via
  mapLiveStatus, now also in server/src/normalize.ts) so a stale harvest
  never clobbers a fresh national decision.
- Detail panel shows the baked case officer when live enrichment hasn't
  supplied one; applicant search works automatically once merged
  (applicant_name is already in the search haystack).

Still open / follow-ups:

- Restore "applicant" to the search placeholder once harvest coverage is
  meaningful (a full sweep takes a few nights of 200 s batches).
- Officer facet/search + "which officers grant vs refuse" analytics
  (officer_name is deliberately NOT in the search haystack).
