# Backlog

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
  Planify's tables-of-counts "pre-planning report". Pull the *full* available
  history (not just 2012+). Buyers skew traditional (solicitors, agents,
  older property people), so it must read like a professional document, not a
  dashboard. Contents (draft): property identity + map/aerial/Street View
  (with capture date) + zoning (code, name, objective) + development plan;
  complete planning history for the address (every application, full
  description, decision, AI plain-English summary, conditions of grant,
  refusal reasons, ABP appeal outcome), flagged for refusals/appeals/
  live/withdrawn/extensions; commencement notices (granted-but-not-built vs
  under construction vs completed); PPR sale history; constraints/risk (flood,
  protected structure/ACA if available); a *written narrative* tying it
  together (the bit Planify skips); optional nearby-precedent comps; source
  links + methodology + disclaimer ("evidence & precedent", not advice — see
  liability note). Delivered as a print-clean PDF and/or the standalone
  microsite above. Monetisable per-report (solicitor/agent) as well as in-app.

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
