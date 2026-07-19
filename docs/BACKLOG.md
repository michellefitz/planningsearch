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
