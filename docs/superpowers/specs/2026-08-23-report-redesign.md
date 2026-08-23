# Pre-planning report redesign

**Goal:** Restructure the pre-planning report so a solicitor or architect can read it cold and understand everything about a site — planning history, constraints, nearby precedent, and what it all means — without wading through raw data or cross-referencing application numbers.

**Core problem:** The current report dumps raw data sections (designations, decision documents, heritage codes, area stats) without enough narrative glue. A reader gets zoning text, then jumps to area statistics, then a list of nearby applications including invalid/incomplete ones, then raw decision document extracts with application numbers they've never seen before. It's comprehensive but not digestible.

**Target users:** Solicitors doing conveyancing due diligence. Architects doing pre-planning research. Homeowners checking what happened near them before applying.

---

## Report structure

### 1. Property header (keep as-is)

- Street View + Aerial imagery side by side
- Project name, address, Eircode, generation date
- Report number

No changes needed. This works well.

### 2. At a glance (new section, replaces nothing — sits at the top)

A 2-3 sentence AI-written summary covering:
- What the zoning allows here
- Whether there are any constraints worth knowing about (flood, heritage, RZLT, derelict)
- One line on the planning history trend ("Neighbours have consistently been granted extensions and attic conversions" or "No planning history within 50m")

This is the thing a solicitor reads first to decide whether to keep reading. It replaces the "Site context" section that currently appears at the bottom and duplicates designations.

**Drop:** The current "Site context" section at the end of the report.

### 3. Site constraints (replaces Designations + Flood & ground + Heritage — merged into one section)

One compact table/list. Each row:

| Check | Result | What it means |
|---|---|---|
| Zoning | Existing Residential / Infill · Leixlip LAP 2020-2023 | Proposal must be a permitted or open-for-consideration use |
| RZLT | Yes — parcel KELA00002789, 5.359 ha | Land identified as vacant/idle; liable for RZLT |
| Derelict sites | Not on a published register | (only 5 councils publish data) |
| Flood risk | Not within a mapped flood extent | |
| Groundwater | [result when available] | |
| Radon | [result when available] | |
| Protected structure | No | |
| Architectural Conservation Area | No | |
| Heritage (NIAH) | None within 250m | |
| Archaeology (SMR) | FUFI EASTON — 18 potential sites found during Celbridge Interchange monitoring | Within a Zone of Archaeological Notification |

Each check is one row with a clear result and a plain-English meaning. No separate sections, no raw codes without explanation. The "FUFI EASTON 228m" that currently appears in the heritage section should be rendered as the monument's actual description, not its code.

### 4. Planning history at this address (new section, partly replaces "Nearby precedents")

Applications **at this address or within ~20m** (the property itself and immediately adjacent). Filters:

- **Exclude** incomplete and invalid applications (never proceeded — not relevant)
- **Include** granted, refused, withdrawn, pending, further info, appealed
- Sort newest first

Each application as a compact card:

```
062690 · 19 Glen Easton Gardens · Granted 5 Jul 2007 (expired)
First floor extension above existing single storey living area on the side of the house.
Conditions: matching external finishes, joint occupation, surface water soakaway
Commencement: none filed
```

Key points per application:
- Reference, address, outcome + date
- One-line AI description (already have this)
- Notable conditions as short phrases, not full text
- Commencement/completion status ("commenced Jan 2025" / "none filed" / "completed")
- Appeal outcome inline if appealed ("Granted → Appeal modified condition 2")
- Expiry date if expired

**Drop:** The full "From the decision documents" extracts that currently follow the precedent list. The raw decision text with bullet-point conditions is too much. Summarise the key conditions inline instead.

### 5. What happened nearby (replaces "Nearby precedents" for 20m-1km radius)

Applications **between ~20m and 1km** (neighbours, not the property itself). Same filters — no incomplete/invalid.

**Grouped by type of work** rather than listed by distance:
- Extensions & conversions
- Attic conversions
- New dwellings
- Change of use
- Other

Within each group, show the applications as compact cards (same format as section 4 but briefer — no conditions detail unless refused or appealed).

After the cards, AI-written **condition themes with cited examples**. State the theme, then list the specific applications that evidence it with a one-line summary of the relevant condition:

- **Matching external finishes** — required on most grants in this area
  - 062690 (19 Glen Easton Gardens) — external finishes must match existing dwelling
  - 22506 (22 Glen Easton Gardens) — 11 conditions imposed; schedule not available
- **Surface water management** — soakaway or on-site attenuation required
  - 062690 (19 Glen Easton Gardens) — surface water via soakaways or water system to BS 8301:1985
- **Joint occupation** — extensions must remain part of the original dwelling
  - 062690 (19 Glen Easton Gardens) — must be jointly occupied as single housing unit, not sold or let separately
- **Appeal outcomes**
  - 24134 (19 Glen Easton Gardens) — An Coimisiun Pleanala removed a condition restricting dormer scale, finding it would accord with the Development Plan

Each theme is a heading the reader can scan, and each example is a specific application they can look up. This gives the specificity a solicitor needs — a thematic summary alone could oversimplify or miss a condition that matters for their particular case.

**Appeals in the area** — explicitly called out as a subsection. For each appeal:
- Which application, what was proposed, what the council decided
- Why it was appealed (applicant appeal of refusal/conditions, or third-party appeal of a grant)
- What An Coimisiun Pleanala decided and why (from the board order summary)
- What changed — conditions added, removed, or modified

Appeals are the strongest signal of what the council gets wrong in an area and what the Commission considers acceptable. A reader planning similar work needs this front and centre.

**Further Information requests** — themed like conditions. When the council asks for F.I., the request reveals what they're concerned about before they decide. Common F.I. themes in the area (e.g. "shadow analysis requested on 3 of 8 applications", "traffic survey required for change-of-use proposals") help a reader anticipate what their own application will be asked for and prepare it upfront.

**Case officers** — list the officers who handled the most recent nearby decisions (from `officer_name`, baked via the nightly agile harvest). A simple line: "Recent applications in this area were assessed by [Officer A] (4 decisions) and [Officer B] (2 decisions)." This gives the reader an indication of who they may be dealing with. No commentary on individual officers — just the names and counts.

This replaces both the raw precedent list and the "From the decision documents" section.

### 6. How this area decides (keep as-is)

The area statistics table — grant rate, median decision time, refused count, appealed count. Within 2km and across the authority.

No changes needed.

### 7. Considerations (keep but refine)

The AI narrative. Rules:

- **No duplication** of planning history or constraints — reference sections ("As shown in the planning history above...") rather than repeating application details
- **Focus on synthesis:** what does the pattern of decisions suggest? What constraints are most relevant to this type of proposal? What should the reader pay attention to?
- If no intent was provided (planning history report mode), focus on: what has happened here, what's the trajectory, what constraints exist
- Development plan reference is good — keep the link

### Dropped sections

| Current section | What happens to it |
|---|---|
| Designations at this site | Merged into "Site constraints" |
| Flood & ground | Merged into "Site constraints" |
| Heritage within 250m | Merged into "Site constraints" |
| From the decision documents | Dropped — key conditions summarised inline on each application card |
| Site context (bottom of Considerations) | Dropped — covered by "At a glance" |
| Incomplete/invalid applications | Filtered out everywhere |

---

## Data changes needed

### Filter incomplete/invalid from precedents
In `server/src/preplan/report.ts` and `api/_preplan/pipeline.mjs`, filter the precedent query to exclude `status IN ('incomplete', 'invalid')`.

### Group precedents by work type
Use the existing `is_domestic_guess` and description-based classification (the `development-TYPE classifier` mentioned in the backlog) to bucket applications. Can be a simple keyword classifier on the description — "extension", "attic", "conversion", "new dwelling", "change of use", etc.

### Summarise conditions as themes
Instead of rendering the full decision document text, extract the notable conditions per application (already available from the conditions endpoint) and pass them to the AI as structured input for theme extraction.

### Heritage: render descriptions not codes
The SMR data has `CLASSDESC`, `WEB_NOTES`, and `TOWNLAND` fields. Use `CLASSDESC` as the primary label instead of the raw monument code.

### "At a glance" summary
A new prompt section that takes the designations, flood/ground, heritage results and the precedent pattern, and writes 2-3 sentences.

---

## Implementation notes

- The report is generated as a streaming sequence of `PreplanEvent` objects yielded by an async generator (`generateReport`). The restructure changes the section names and order but not the streaming architecture.
- The AI narrative (Considerations) is already a single Claude call at the end of the pipeline. The "At a glance" summary is a new, shorter call at the beginning (or derived from the same data).
- The "From the decision documents" section currently drives deep-dive agent calls per precedent. These can be replaced with the conditions-endpoint summaries that already exist, which are cheaper and faster.
- Both backends (Fastify `server/src/preplan/report.ts` and Vercel `api/_preplan/pipeline.mjs`) need the same changes.
- The `ReportView.tsx` component renders the sections — its structure will change to match the new section layout.

---

## Out of scope for this redesign

- PDF export beyond window.print() — separate feature
- Branding / white-label — separate feature  
- Saved report diffing ("what changed since last report") — separate feature
- Pulling in additional datasets (groundwater, radon) — tracked separately
- Professional mode citing development plan policy numbers — separate feature
