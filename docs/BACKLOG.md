# Backlog

- **Google Maps API key for inline property imagery.** The detail sheet
  already renders Street View + aerial thumbnails when `VITE_GOOGLE_MAPS_KEY`
  is set at build time. To activate: Google Cloud project with billing →
  enable *Street View Static API* + *Maps Static API* → create a key
  restricted to the Vercel domain and those two APIs → add as
  `VITE_GOOGLE_MAPS_KEY` in Vercel env vars → redeploy. ($200/month free
  credit ≈ ~25k image loads; metadata checks are free.)

- **Applicant/agent names for DLR.** Kildare (eplanning scrape) and South
  Dublin / Dublin City / Fingal (agile API, see server/src/agile.ts) are
  covered; Dún Laoghaire-Rathdown remains — it runs SwiftLG
  (planning.dlrcoco.ie/swiftlg), which needs its own scraper.

- **Agile API notes (solved).** Base `planningapi.agileapplications.ie/api`,
  tenant headers x-client (SD / DCC / FG) + x-product CITIZENPORTAL +
  x-service PA, captured from a browser session. Useful endpoints:
  `/application/search?query={ref}` and `/application/{id}` (rich detail,
  incl. applicant + agent). `/application/{id}/document` exists but returns
  [] for all three Irish councils — no file listings this way.

- **Kildare submissions list on the detail sheet.** eplanning pages carry a
  hidden "Submitter Details" popup (contact name, recorded/acknowledged
  dates) on applications with submissions — same page the parties backfill
  already fetches. Note statutory consultees (e.g. Uisce Éireann) appear
  alongside genuine third-party objectors, so show names, not just a count.

- **"Appealed" filter as an area-level contested signal.** Appeal fields are
  in the bulk dataset (unlike objections); a filter chip would let users see
  contested applications across the map.

- **Scheduled redeploy for data freshness.** The Vercel bundle only refreshes
  on deploy; a weekly cron (Vercel deploy hook) would keep the register data
  current without code changes.
