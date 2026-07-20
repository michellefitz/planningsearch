# Planning systems used by Ireland's 31 local authorities

Surveyed 2026-07-20 from the national planning dataset (each authority's most
recent `LinkAppDetails` URLs) plus direct probes of the portals and APIs.

**Headline: there are only 2 distinct systems nationally, and PlanView already
integrates with both.** 24 councils share one portal (eplanning.ie), 6 are on
Agile Applications, and Cork City self-hosts the same software as eplanning.ie.
Everything remaining is configuration, not new scrapers.

## System families

| # | System | Councils | PlanView status |
|---|--------|----------|-----------------|
| 1 | **ePlan** shared portal (`www.eplanning.ie/{code}/AppFileRefDetails/{id}/0`) + **iDocs** document viewer | 24 | ✅ Built for Kildare — same code works for all 24; only the per-council iDocs hostname differs |
| 2 | **ePlan self-hosted** (`planning.corkcity.ie`, same software + iDocs) | 1 (Cork City) | ✅ Same as #1 with a different base URL (verified: page is ePlan, docs via `idocsWebDpss`) |
| 3 | **Agile Applications** (`planning.agileapplications.ie/{slug}`, API at `planningapi.agileapplications.ie` with `x-client` header) | 6 | ✅ Built for SD/DCC/FG/DLR; Cork County (`CORKCOCO`) and Wexford (`WEXFORD`) verified working against the same API incl. `/document` |

## Full table

| Council | System | Portal / tenant | Notes |
|---------|--------|-----------------|-------|
| Carlow | ePlan + iDocs | eplanning.ie/CarlowCC | |
| Cavan | ePlan + iDocs | eplanning.ie/CavanCC | |
| Clare | ePlan + iDocs | eplanning.ie/ClareCC | |
| Cork City | ePlan + iDocs (self-hosted) | planning.corkcity.ie | Same `AppFileRefDetails` pattern; iDocs at `idocsWebDpss` on same host |
| Cork County | **Agile** | slug `corkcoco`, `x-client: CORKCOCO` | Search + `/document` verified 2026-07-20 |
| Donegal | ePlan + iDocs | eplanning.ie/DonegalCC | |
| Dublin City | **Agile** | slug `dublincity`, `x-client: DCC` | ✅ Live in PlanView; docs via NEC PublicAccess DMS (agile `/document` empty) |
| Dún Laoghaire–Rathdown | **Agile** | slug `dunlaoghaire`, `x-client: DLR` | ✅ Live in PlanView; docs via agile `/document` |
| Fingal | **Agile** | slug `fingal`, `x-client: FG` | ✅ Live in PlanView; docs via agile `/document` |
| Galway City | ePlan + iDocs | eplanning.ie/GalwayCity | |
| Galway County | ePlan + iDocs | eplanning.ie/GalwayCC | |
| Kerry | ePlan + iDocs | eplanning.ie/KerryCC | |
| Kildare | ePlan + iDocs | eplanning.ie/KildareCC | ✅ Live in PlanView (register, iDocs docs, decision-order summaries) |
| Kilkenny | ePlan + iDocs | eplanning.ie/KilkennyCC | |
| Laois | ePlan + iDocs | eplanning.ie/LaoisCC | |
| Leitrim | ePlan + iDocs | eplanning.ie/LeitrimCC | |
| Limerick City & County | ePlan + iDocs | eplanning.ie/LimerickCCC | |
| Longford | ePlan + iDocs | eplanning.ie/LongfordCC | |
| Louth | ePlan + iDocs | eplanning.ie/LouthCC | |
| Mayo | ePlan + iDocs | eplanning.ie/MayoCC | iDocs served from a relative path on eplanning.ie |
| Meath | ePlan + iDocs | eplanning.ie/MeathCC | iDocs at `idocswebdpss.meathcoco.ie` |
| Monaghan | ePlan + iDocs | eplanning.ie/MonaghanCC | |
| Offaly | ePlan + iDocs | eplanning.ie/OffalyCC | |
| Roscommon | ePlan + iDocs | eplanning.ie/RoscommonCC | |
| Sligo | ePlan + iDocs | eplanning.ie/SligoCC | |
| South Dublin | **Agile** | slug `southdublin`, `x-client: SD` | ✅ Live in PlanView; docs via council DMS at planning.southdublin.ie (agile `/document` empty) |
| Tipperary | ePlan + iDocs | eplanning.ie/TipperaryCC | |
| Waterford City & County | ePlan + iDocs | eplanning.ie/WaterfordCCC | |
| Westmeath | ePlan + iDocs | eplanning.ie/WestmeathCC | |
| Wexford | **Agile** | slug `wexford`, `x-client: WEXFORD` | Search + `/document` verified 2026-07-20 |
| Wicklow | ePlan + iDocs | eplanning.ie/WicklowCC | |

Totals: 24 shared ePlan + 1 self-hosted ePlan + 6 Agile = 31. The national
ArcGIS dataset covers all 31, so search/map/detail metadata needs no per-council
work at all — only documents, conditions and portal links are system-specific.

## What "adding the rest" actually involves

- **Cork County + Wexford (Agile)** — add two entries to `AGILE_CLIENT_BY_AUTHORITY`
  / `AGILE_SLUGS` and an authority config each. Conditions, refusal reasons,
  applicant/agent and documents should all work exactly like Fingal/DLR.
  One unknown per tenant: whether `/document` is empty for some (as it is for
  SD and DCC, which use their own DMS) — both tested fine so far.
- **The 24 eplanning councils + Cork City (ePlan)** — reuse the Kildare
  integration. The only per-council variable is the iDocs base URL, which is
  embedded in each council's `AppFileRefDetails` page (e.g. Meath →
  `idocswebdpss.meathcoco.ie`, Cork City → same host, Mayo → relative path), so
  it can be discovered once per council with a single scrape and stored in
  `authorities.ts`. Like Kildare, ePlan councils have no structured conditions
  API — refusal reasons come from the scanned decision order (the
  decision-summary pipeline already handles this).
- **Caveats** — a handful of iDocs instances sit on council-owned hostnames that
  occasionally have TLS/uptime quirks; and the dataset's `LinkAppDetails` can be
  stale after migrations (South Dublin was), so portal links should keep going
  through the click-time resolver.
