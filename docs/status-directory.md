# Status & Decision Directory

A single reference for **every status/decision/appeal/commencement value the
product handles, where each one comes from per council, and where the gaps
are.** Written to answer: do we have consistency issues across the five
authorities, and should the UI stop collapsing everything into one pill?

> TL;DR — we flatten four independent real-world axes (validation lifecycle,
> council decision, appeal, commencement) into **one** `status` column, then
> show one pin/badge. That is the root of the "unknown / question-mark /
> invalid-vs-decision-notice" confusion. See [§6 Gaps](#6-known-gaps--consistency-issues)
> and [§7 Proposal](#7-proposal-multiple-pills).

---

## 1. The canonical statuses

There are **nine** canonical statuses. This is the closed set the whole app
speaks (`CanonicalStatus` in `server/src/normalize.ts:9`). Everything from every
council is mapped onto exactly one of these and stored in
`applications.status`.

| Canonical | Label (`STATUS_LABELS`) | Map glyph / colour | Meaning |
|---|---|---|---|
| `pending` | Pending decision | **P** · blue `#2563eb` | Live, no decision yet |
| `further_info` | Further information | **F** · purple `#9333ea` | Council asked for more; clock paused |
| `granted` | Granted | **G** · green `#16a34a` | Permission granted (incl. conditional) |
| `refused` | Refused | **R** · red `#dc2626` | Permission refused |
| `withdrawn` | Withdrawn | **W** · grey `#6b7280` | Applicant withdrew |
| `invalid` | Invalid | **I** · amber `#a16207` | Formally declared invalid |
| `incomplete` | Incomplete | (no glyph) | Pre-validation: missing docs/fees |
| `appealed` | Under appeal | **A** · orange `#ea580c` | At An Coimisiún Pleanála |
| `unknown` | Unknown | **?** | Couldn't map — see §6 |

Source of truth for glyph/colour is `web/src/components/MapView.tsx:36`
(`STATUS_STYLE`); the filter chips and legend are generated from that same map,
so status is genuinely one-dimensional in the UI today.

### The problem in one sentence
A real application is **not** one of these at a time. It simultaneously has a
*validation state*, a *decision outcome*, an *appeal state*, and a
*commencement state* — and we can only surface one. `appealed` and `granted`
are mutually exclusive in our model even though "granted, then appealed, appeal
upheld, work commenced" is one coherent real history.

---

## 2. The four axes we've flattened

| Axis | Real values | Where we store it | Shown as a pill? |
|---|---|---|---|
| **A. Validation lifecycle** | incomplete → valid/pending → further-info → withdrawn/invalid → decided | `status` (partly) | the one pill |
| **B. Council decision** | grant / grant-with-conditions / refuse / split (part grant, part refuse) / declared invalid | `status` (overwrites A) + `decision` / `decision_raw` | folded into the pill |
| **C. Appeal** | none / lodged / decided (grant / refuse / modified / conditions varied) | `appeal_status`, `appeal_reference`, `appeal_decision`, `appeal_decision_date` | **no** — timeline only |
| **D. Commencement (BCMS)** | not started / commenced / completed | `commencement_date`, `completion_date`, `commencement_units`, `commencement_count` | **no** — timeline only |

The single `status` column is produced by a **priority collapse** of A + B + C
at ingest (`server/src/ingest/arcgis.ts:145`):

```
withdrawnDate present                → withdrawn
else appealDecision is clear grant/refuse → that (appeal supersedes council)
else                                 → council status (normalizeStatus(status, decision))
```

So an appeal decision can silently overwrite the council decision, and
commencement never touches `status` at all.

---

## 3. Raw → canonical mapping rules

All in `server/src/normalize.ts`. Order matters — first match wins.

### 3a. Status-text rules (`STATUS_RULES`)
| Regex (case-insensitive) | → canonical |
|---|---|
| `appeal` | `appealed` |
| `further info`, `f.i. req/rec`, `additional information` | `further_info` |
| `withdraw` | `withdrawn` |
| `incomplete`, `not valid` | `incomplete` |
| `invalid` | `invalid` |
| `refus`, `reject` | `refused` |
| `grant`, `approv`, `conditional`, `unconditional` | `granted` |
| `pending`, `new application`, `under consideration`, `awaiting`, `received`, `registered`, `live` | `pending` |

### 3b. "Decided-opaque" statuses (`DECIDED_OPAQUE`)
Statuses that mean *"case closed, look at the Decision field for the outcome"*:
`finalised`, `finalized`, `decision made`, `decided`, `closed`, `\bcomplete`.
When the status matches these, we read the **Decision** field first, then fall
back to the status text, then `unknown`.

### 3c. Decision-text fallback (`fromDecision`)
When status is blank or opaque: `refus/reject`→refused, `grant/approv/conditional`→granted,
`withdraw`→withdrawn, `invalid`→invalid.

### 3d. Final fallbacks
- Blank status **and** blank decision → `pending` (assume live).
- Non-blank but unrecognised → `unknown`.

### Worked examples
| status_raw | decision | → | Note |
|---|---|---|---|
| `New Application` | — | `pending` | |
| `Further Information Requested` | — | `further_info` | |
| `Decision Made` | `Grant Permission` | `granted` | opaque status defers to decision |
| `Application Withdrawn` | — | `withdrawn` | |
| `Invalid Application` | — | `invalid` | |
| `Application Declared Invalid` | — | `invalid` | matched by `invalid` rule |
| `Validation` | — | **`unknown`** | stage word, not a status (§6.2) |
| `Finalised Unconditional` | — | `granted` | outcome embedded in status |
| `Appealed to An Bord Pleanála` | `Grant Permission` | `appealed` | |
| **`Decision Notice Issued`** | `Application Declared Invalid` | `invalid` *if decision present* / **`unknown`** *if not* | **the Dublin City bug — §6.1** |

---

## 4. Per-council source matrix

Two source systems back the five authorities:

| Council | `sourceSystem` | Baseline status source | Live status enrichment | Structured conditions | Parties backfill |
|---|---|---|---|---|---|
| **Dublin City** | `agile` | National ArcGIS | Agile portal API (gated, §5) | ✅ agile `/conditions` | agile detail |
| **Fingal** | `agile` | National ArcGIS | Agile portal API (gated) | ✅ agile `/conditions` | agile detail |
| **Dún Laoghaire-Rathdown** | `agile` | National ArcGIS | Agile portal API (gated) | ✅ agile `/conditions` | agile detail |
| **South Dublin** | `agile` | National ArcGIS | Agile portal API (gated) | ✅ agile `/conditions` | agile detail |
| **Kildare** | `eplanning` | National ArcGIS | **none** | ❌ (PDF AI-extract only) | eplanning HTML scrape |

Appeals (all five) and commencement (all five) are separate national datasets,
joined on top — see §5.3 / §5.4.

### The asymmetry that bites us
- All five get their **baked** status from the **same** national ArcGIS feed, so
  the raw-value quirks are shared.
- Only the four **agile** councils can be *corrected live* from the council
  portal (and only under a narrow condition — §5.2). **Kildare cannot be
  corrected at all** — its `status` is whatever the national feed said, forever,
  until the next full ingest.
- Only the four agile councils have machine-readable conditions/refusal reasons.
  Kildare's real outcome for tricky cases (e.g. "declared invalid") lives only
  inside a scanned decision-order **PDF**, read on demand by the AI extractor
  (`/api/applications/:id/decision-summary`), and **never written back to
  `status`.**

---

## 5. Field inventory — exactly what we fetch, from where

### 5.1 National ArcGIS feed (baseline for ALL councils)
`server/src/ingest/arcgis.ts` `FIELD_MAP`. Status-relevant fields:

| Our field | ArcGIS field | Used for |
|---|---|---|
| `status_raw` | `ApplicationStatus` | axis A/B baked status |
| `decision` / `decision_raw` | `Decision` | axis B, opaque-status fallback |
| `decision_date` | `DecisionDate` | timeline |
| `decision_due_date` | `DecisionDueDate` | "decision due" |
| `further_info_requested_date` | `FIRequestDate` | further_info timeline |
| `further_info_received_date` | `FIRecDate` | further_info timeline |
| `withdrawn` (→ status) | `WithdrawnDate` | forces `withdrawn` |
| `final_grant_date` | `GrantDate` | final grant |
| `appeal_status` | `AppealStatus` | axis C |
| `appeal_reference` | `AppealRefNumber` | axis C + ACP deep link |
| `appeal_lodged_date` | `AppealSubmittedDate` | axis C |
| `appeal_decision` | `AppealDecision` | axis C (supersedes council) |
| `appeal_decision_date` | `AppealDecisionDate` | axis C |
| `expiry_date` | `ExpiryDate` | permission expiry |

> ⚠️ These field names were verified against the live schema on 2026-07-18 but
> the whole status picture rests on ArcGIS's `ApplicationStatus` + `Decision`
> being populated and current — and it lags the councils by weeks (§6).

### 5.2 Agile citizen-portal API (Dublin City / Fingal / DLR / South Dublin)
`server/src/agile.ts`. Fetched **on demand** when a detail sheet opens
(`/api/applications/:id/enrich`).

- `GET /application/{id}` → `pickAgileStatus()` reads the **longest** string on
  any `*status*` key (`applicationStatus`, `applicationStatusDescription`,
  `statusDescription`…), skipping appeal/date keys. Also applicant, agent,
  full description, eircode.
- `GET /application/{id}/conditions` → `decisionText`, `decisionDate`, and coded
  prescriptions: **C** condition of grant, **R** refusal reason, **D**
  further-info directive, **I** informative, **N** note.

**How the live status is (not) used** — `server/src/api.ts:677`:
```
useLiveStatus = bakedStatus === "unknown" && liveStatus !== "unknown"
```
i.e. the live portal status only ever fills in a blank. It cannot **correct** a
baked status that is wrong-but-mapped, and when it does run it calls
`normalizeStatus(liveStatusRaw)` with **no decision argument** and never looks at
`conditions.decisionText`.

### 5.3 Appeals — An Coimisiún Pleanála (all councils)
- Structured appeal fields come from the national feed (5.1).
- The 6-digit case number is parsed from any appeal-ref form
  (`ABP-319506-23`, `PL29N.301702`, bare `319506`) → deep link
  `pleanala.ie/en-ie/case/{n}` (`server/src/abp.ts`).
- The live case page is scraped on demand (`/api/applications/:id/appeal`) for
  parties/board-direction/docs — enrichment only, never writes `status`.

### 5.4 Commencement — BCMS / NBCO (all councils)
`server/src/ingest/bcms.ts`. Separate CKAN dataset, joined at ingest by
normalised planning reference (with `…/WEB`, trailing `W` variants, and appeal-
ref fallback). Populates `commencement_date`, `completion_date`,
`commencement_units`, `commencement_count`. **Never affects `status`** — surfaced
only in the detail timeline ("Work commenced/ due to commence / completed").

### 5.5 Kildare (eplanning)
`server/src/documents.ts`. Only parties (applicant/agent) are scraped from the
`AppFileRefDetails` HTML; the reasons-for-refusal / declared-invalid text exists
only in the scanned decision PDF, AI-extracted on demand and **not** written to
`status`. No live status, no structured conditions.

---

## 6. Known gaps & consistency issues

### 6.1 "Decision Notice Issued" trumps the real outcome (the Dublin City report)
`Decision Notice Issued` is **not** in `STATUS_RULES` and **not** in
`DECIDED_OPAQUE`. Consequences:
- If the national `Decision` field **is** populated (`Application Declared
  Invalid`), `normalizeStatus` *does* fall through to it and returns `invalid`
  correctly — because the status matched no rule.
- If the national `Decision` field is **empty** (common for Dublin City invalids,
  where the outcome is only on the portal / in the decision doc), the status
  matches nothing → **`unknown`** → the "?" pin.
- In the **live agile** path, `pickAgileStatus` deliberately takes the
  *longest* status string, so a verbose stage label like "Decision Notice
  Issued" outranks a terse "Invalid" — and then the decision text is never
  consulted, and even a correct live read is discarded unless the baked status
  was `unknown`.

**✅ Fixed.** (a) `decision notice` / `notification of decision` added to
`DECIDED_OPAQUE`, so the stage defers to the decision (`normalize.ts`).
(b) `fetchAgileDetail` now also reads the live **decision** (`pickAgileDecision`)
and `/enrich` feeds it into `normalizeStatus`, so the outcome wins over the
stage. (c) "longest wins" in `pickAgileStatus` is left as-is — it's now moot,
because even when a verbose stage label wins, the decision is consulted and
takes precedence. Mirrored in the serverless entry `api/index.mjs`.

### 6.2 "Validation" and other bare stage words → `unknown` ("?")
**✅ Fixed.** Previously "Validation" and similar early-lifecycle stages mapped
to `unknown` on the theory that a stage word alone isn't an outcome — but that
turned genuinely live applications (e.g. DLR REF10726, received days earlier,
no decision) into "?" pins the map could never self-correct. The early stages
("Validation" / "Validated" / "Under Assessment" / "Lodged" / "Acknowledged")
now map to **pending**; the invalid/incomplete rules still run first, and a
recorded decision still supersedes the stage (§6.8), so a real invalid or a
decided case is unaffected. Baked at ingest, so the map/list read pending
directly. Two other truncation/date sources of "?" were fixed alongside: the
national Decision text is truncated (~24 chars) so "…DECLARED INVALID" arrives
as "…INVA" — the `declared inv` stem is now matched — and a bare `GrantDate`
with blank decision text now bakes as granted.

### 6.3 National feed lag
The whole baked status is only as fresh as the last `npm run ingest`. Pending →
decided → appealed transitions can be weeks stale. Agile councils can be nudged
live per-application on sheet-open; Kildare cannot at all.

> **Partly addressed.** The live-portal correction in `/enrich` previously only
> filled a baked `unknown`. It now also *corrects* a stale `pending` /
> `further_info` / `incomplete` when the portal shows a terminal outcome
> (granted/refused/invalid/withdrawn) — the "SD22A/0440 still pending" class of
> bug. On the long-running server this persists back to the map; on the
> read-only Vercel bundle it corrects the open detail sheet only (the map pin
> reflects the bundle until the next rebuild). A decided baked status is never
> overridden, so a fresh national decision is never clobbered.

### 6.4 `invalid` vs `incomplete` collapse
We keep them distinct in the model, but source systems use the words
interchangeably, and `incomplete` has no map glyph — so incomplete rows render
without a letter.

### 6.5 Appeal supersession hides the council decision
When `AppealDecision` is a clear grant/refuse it overwrites `status`, so the pin
reads `granted` with no visible signal that it went to appeal. Conversely a
`MODIFIED` / `CONDITIONS VARIED` appeal outcome is deliberately ignored for
status but changes the real conditions.

### 6.6 Split / part decisions
"Grant in part, refuse in part" has no representation — it collapses to whichever
of grant/refuse the regex hits first (`grant` is checked before… actually
`refus` is checked first in `fromDecision`, so a split reads as `refused`).

### 6.7 Commencement invisible outside the sheet
A permission where work has started/finished looks identical on the map to one
that was never built.

### 6.8 A stale status stage short-circuits a recorded decision
**✅ Fixed.** The clearest instance of §6.3's lag, but in the *baked* data, not
the live path: SD22A/0440 (South Dublin) carried `status_raw = "Registered
Application"` → `pending`, yet also `decision = "GRANT PERMISSION"` with a 2023
decision date and final grant. `normalizeStatus` matched the `registered →
pending` rule and returned before ever reading the Decision field, so the map,
list and sheet all showed "pending" for a long-granted permission. Now a
recorded decision supersedes a status that is only a not-yet-decided stage
(pending / further-info / incomplete), while a status that itself names a
terminal outcome (refused / withdrawn / invalid / appealed) still stands. Baked
at ingest, so it corrects everywhere on the next data rebuild — no live call.

---

## 7. Proposal: multiple pills

Stop collapsing. Keep `status` as the **primary lifecycle pill** but render the
other axes as their own secondary pills, driven by data we already store:

| Pill | Shown when | Source (already have it) |
|---|---|---|
| **Primary status** | always | `status` |
| **Appealed** ↗ | `appeal_reference` present | axis C fields |
| **Appeal outcome** | `appeal_decision` present | `appeal_decision` |
| **Commenced** / **Completed** | `commencement_date` / `completion_date` | axis D fields |
| **Conditions** *n* | conditions loaded (agile) | `/conditions` count |

Bigger structural option (worth discussing): split `status` into explicit
columns — `validation_state`, `decision_outcome`, `appeal_state`,
`build_state` — and derive the single pin colour from a documented priority,
while the sheet shows all four. That removes the lossy collapse in
`arcgis.ts:145` and makes "granted → appealed → upheld → commenced" expressible.

**✅ First slice shipped:** §6.1 (invalid/decision-notice) is fixed and the
live-status correction broadened (§6.3); the detail sheet and result cards now
show **Type**, **Appealed**, and **Commenced/Built** pills next to the status
badge (`SecondaryPills` in `ResultsList.tsx`); application **type is inferred
from the description** when the national type field is blank
(`deriveApplicationType`), so retention is separated from ordinary permission;
and an application-**type filter** was added to the filter bar. The full
four-axis schema split remains the larger change to sequence after.

---

*Generated from code at branch `claude/pending-applications-return-ynuu0b`.
Key files: `server/src/normalize.ts`, `server/src/ingest/arcgis.ts`,
`server/src/agile.ts`, `server/src/api.ts` (`/enrich`), `server/src/ingest/bcms.ts`,
`server/src/abp.ts`, `web/src/components/MapView.tsx`.*
