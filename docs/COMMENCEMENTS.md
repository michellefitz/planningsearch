# Commencement notices (BCMS)

Answers the question the planning register can't: **did a granted permission
actually get built?** Before starting work, builders must file a commencement
notice with the building control authority via the Building Control Management
System (BCMS); on finishing, a Certificate of Compliance on Completion (CCC).

## Source

- NBCO open-data portal: https://data.nbco.gov.ie (CKAN, CC-BY, updated ~daily)
- Dataset `bcnccc`, resource `0774e781-7af8-46da-b623-872e74cf541e`
  ("BuildingsCNsCCCs") — ~237k rows nationally since 2014, one row per
  **building** on a notice (dedupe by `CN_Number`).
- Queryable via `datastore_search` (needs a User-Agent header) and
  `datastore_search_sql`. DLR is spelled `Dún-Laoghaire Rathdown County
  Council` in `LocalAuthority`.
- Key fields: `CN_Number` (notice ref; `SN…` = 7-day notice),
  `CN_Planning_Permission_Number` (free-text join key),
  `CN_Commencement_Date` (notified start — filed 14–28 days before works),
  `CCC_Date_Validated`, `CN_Total_Number_of_Dwelling_Units`, `CN_LAT`/`CN_LNG`,
  `CN_Eircode`.

## Join

`server/src/ingest/bcms.ts` — fetched per authority, deduped per notice, and
joined to applications by normalised permission number (`refVariants`:
uppercase, strip separators, strip `…WEB`/trailing `W` web-submission
suffixes) with a fallback to the application's ABP appeal reference. Runs in
`export-json.ts` (Vercel bundle) and after `ingest/run.ts` (SQLite); failures
are non-fatal.

Caveat: the permission number is typed by the submitter — some cite eplanning
internal ids or leave it blank, so absence of a match is *evidence* work
hasn't started, not proof.

## API surface (for agents)

Application objects (search results and `/api/applications/:id`) carry:

| Field | Meaning |
|-------|---------|
| `commencement_date` | Notified commencement date (may be days in the future) |
| `completion_date` | CCC validation date — works certified complete |
| `commencement_notice` | Notice number, e.g. `CN0139753FL` (detail only) |
| `commencement_units` | Dwelling units on the notice (detail only) |
| `commencement_count` | Notices matched — phased sites file several (detail only) |

Search filter: `GET /api/search?commenced=1` (combines with all existing
params — e.g. `commenced=1&lat=…&lng=…&sort=distance` for "work starting near
me", or `commenced=1&receivedFrom=…` for supply actually materialising).

## UI

Result cards show a green `work commenced` / `built` tag; the detail panel
adds timeline steps ("Work commenced on site", "Completion certified") and a
line in the Decision section — including "No commencement notice on file" on
granted permissions with no match. Filter toggle: "Work commenced".
