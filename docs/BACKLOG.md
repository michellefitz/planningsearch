# Backlog

- **Google Maps API key for inline property imagery.** The detail sheet
  already renders Street View + aerial thumbnails when `VITE_GOOGLE_MAPS_KEY`
  is set at build time. To activate: Google Cloud project with billing →
  enable *Street View Static API* + *Maps Static API* → create a key
  restricted to the Vercel domain and those two APIs → add as
  `VITE_GOOGLE_MAPS_KEY` in Vercel env vars → redeploy. ($200/month free
  credit ≈ ~25k image loads; metadata checks are free.)

- **Applicant names for the four Dublin authorities.** The eplanning.ie
  backfill only covers Kildare; Dublin City / Fingal / DLR / South Dublin use
  agileapplications.ie, which needs its own scraper.

- **Agile documents API (file listings for agile councils).** Findings so
  far: the SPA calls `GET {apiUrl}application/{id}/document` where apiUrl is
  resolved at runtime per council from identity.agileapplications.ie service
  configurations (`/api/configuration/southdublin` returns an empty value
  anonymously); the cpAPI host `citizenportalapi.agileapplications.ie`
  rejects direct guesses (404) with/without referer or client headers. Next
  step would be watching the browser's network tab on an application-details
  page to capture the real request + auth.

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
