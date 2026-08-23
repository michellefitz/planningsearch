# Pre-planning Report Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restructure the pre-planning report from a data-dump layout to a narrative-first, scannable format suitable for solicitors and architects.

**Architecture:** The report is a streaming async generator (`generateReport`) yielding `PreplanEvent` objects. The restructure changes section names, merges three sections into one, splits precedents into address-level and nearby, adds work-type grouping + condition themes, and rewrites the frontend renderer. Both backends (Fastify `server/src/preplan/` and Vercel `api/_preplan/pipeline.mjs`) must stay in sync.

**Tech Stack:** TypeScript (server), JavaScript (Vercel mjs), React/TSX (frontend), Claude Haiku (AI summaries)

**Spec:** `docs/superpowers/specs/2026-08-23-report-redesign.md`

## Global Constraints

- Both backends must produce identical section shapes — the frontend renders from one interface
- AI calls use Claude Haiku via the existing `callClaude` / `deps.synthesise` pattern
- No new npm dependencies
- `DESIGNATION_MEANING.derelict` is missing in `api/_preplan/pipeline.mjs` — fix as part of Task 1
- Incomplete and invalid applications must be excluded from all precedent sections
- The `rural_housing` section (Vercel-only) is preserved unchanged

---

### Task 1: Filter precedents, add work-type classifier, add officer/appeal/FI fields to row data

**Files:**
- Modify: `server/src/preplan/precedents.ts` (if it exists, else the functions are in report.ts)
- Modify: `server/src/preplan/deps.ts` — add columns to ROW_COLUMNS
- Modify: `api/_preplan/pipeline.mjs` — mirror changes + fix derelict DESIGNATION_MEANING
- Create: `server/src/preplan/classify.ts` — work-type classifier

**Produces:**
- `classifyWorkType(description: string): string` — returns one of: `"extension"`, `"attic_conversion"`, `"new_dwelling"`, `"change_of_use"`, `"demolition"`, `"retention"`, `"other"`
- `selectPrecedents` gains `work_type` on each returned row
- Rows gain `officer_name`, `commencement_date`, `completion_date`, `further_info_requested_date`, `appeal_decision` columns
- `IRRELEVANT_STATUSES` filter applied in `selectPrecedents`

- [ ] **Step 1:** Create `server/src/preplan/classify.ts` with the work-type classifier:

```typescript
export function classifyWorkType(description: string): string {
  if (!description) return "other";
  const d = description.toLowerCase();
  if (/\battic\b.*\b(conver|storage|room|bedroom)|convert.*\battic\b|dormer/.test(d)) return "attic_conversion";
  if (/\b(extension|extend)\b(?!.*\bduration\b)/i.test(d)) return "extension";
  if (/\b(new|erect|construct|build)\b.*\b(dwell|house|home|bungalow|apartment|unit)/i.test(d)) return "new_dwelling";
  if (/\bchange\s+of\s+use\b/i.test(d)) return "change_of_use";
  if (/\bdemoli/i.test(d)) return "demolition";
  if (/\bretention\s+of\b/i.test(d)) return "retention";
  return "other";
}

export const WORK_TYPE_LABELS: Record<string, string> = {
  extension: "Extensions & conversions",
  attic_conversion: "Attic conversions",
  new_dwelling: "New dwellings",
  change_of_use: "Change of use",
  demolition: "Demolition",
  retention: "Retention",
  other: "Other",
};
```

- [ ] **Step 2:** Update `server/src/preplan/deps.ts` ROW_COLUMNS to add `officer_name, commencement_date, completion_date, further_info_requested_date` (4 new columns). These already exist in the applications table.

```typescript
const ROW_COLUMNS =
  "id, authority_id, planning_reference, description, ai_summary, source_url, status, decision, " +
  "decision_date, received_date, address_text, lat, lng, appeal_reference, " +
  "officer_name, commencement_date, completion_date, further_info_requested_date";
```

- [ ] **Step 3:** In `selectPrecedents` (both `server/src/preplan/precedents.ts` and `api/_preplan/pipeline.mjs`), add the incomplete/invalid filter at the top:

```typescript
const eligible = rows.filter(r => r.status !== "invalid" && r.status !== "incomplete");
```

Then add `work_type: classifyWorkType(r.description)` to each scored result.

- [ ] **Step 4:** In `api/_preplan/pipeline.mjs`, add the missing `DESIGNATION_MEANING.derelict` entry (copy from server `point-data.ts` line 90-91).

- [ ] **Step 5:** Mirror the `classifyWorkType` function inline in `api/_preplan/pipeline.mjs` (same pattern as other inlined functions there).

- [ ] **Step 6:** Commit: "Filter incomplete/invalid from precedents, add work-type classifier and extra row columns"

---

### Task 2: Restructure generator sections — merge site_constraints, split precedents

**Files:**
- Modify: `server/src/preplan/report.ts` — change section yields
- Modify: `api/_preplan/pipeline.mjs` — mirror section changes

**Produces:**
- New section `"site_constraints"` replacing separate `designations`, `flood_ground`, `heritage_points`
- Precedents split into `"address_history"` (≤20m) and `"nearby"` (20m–1km)
- Each nearby precedent carries `work_type`
- `"nearby"` section also carries `appeals`, `fi_dates`, `officers` aggregations

**Interfaces:**
- Consumes: `getDesignations`, `getHeritagePoints`, `getFloodGround` from Task 1 (unchanged)
- Consumes: `classifyWorkType` from Task 1

- [ ] **Step 1:** In `generateReport`, replace the three separate section tracks (`designations`, `heritage_points`, `flood_ground`) with a single `site_constraints` track that runs all three in parallel and merges:

```typescript
{
  label: "site_constraints",
  promise: Promise.all([
    deps.getDesignations(lat, lng).catch(() => unavailable("designation services did not respond")),
    deps.getHeritagePoints(lat, lng).catch(() => unavailable("heritage services did not respond")),
    deps.getFloodGround(lat, lng).catch(() => unavailable("flood/ground services did not respond")),
  ]).then(([designations, heritage, flood]) => ({ designations, heritage, flood })),
}
```

- [ ] **Step 2:** Split the precedents section into `address_history` and `nearby`. After `selectPrecedents` returns, partition:

```typescript
const ADDRESS_RADIUS_M = 20;
const atAddress = scored.filter(p => p.distance_m != null && p.distance_m <= ADDRESS_RADIUS_M);
const nearby = scored.filter(p => p.distance_m == null || p.distance_m > ADDRESS_RADIUS_M);
```

Yield `"address_history"` with `{ items: atAddress }` and `"nearby"` with `{ items: nearby, appeals: [], condition_themes: [], fi_count: 0, officers: [] }` (populated in Task 3).

- [ ] **Step 3:** On the `nearby` section, aggregate officer names:

```typescript
const officerCounts: Record<string, number> = {};
for (const p of nearby) {
  const name = p.officer_name?.trim();
  if (name) officerCounts[name] = (officerCounts[name] ?? 0) + 1;
}
const officers = Object.entries(officerCounts)
  .sort((a, b) => b[1] - a[1])
  .slice(0, 5)
  .map(([name, count]) => ({ name, count }));
```

- [ ] **Step 4:** On the `nearby` section, extract appeals:

```typescript
const appeals = nearby
  .filter(p => p.appeal_reference)
  .map(p => ({
    reference: p.planning_reference,
    address: p.address_text,
    description: p.ai_summary ?? p.description,
    status: p.status,
    appeal_reference: p.appeal_reference,
  }));
```

- [ ] **Step 5:** Count F.I. requests:

```typescript
const fi_count = nearby.filter(p => p.further_info_requested_date).length;
```

- [ ] **Step 6:** Mirror all changes in `api/_preplan/pipeline.mjs`.

- [ ] **Step 7:** Commit: "Restructure report sections — merge site_constraints, split address_history/nearby"

---

### Task 3: Replace deep dives with condition theme extraction

**Files:**
- Modify: `server/src/preplan/report.ts` — replace deep-dive phase with condition themes
- Modify: `api/_preplan/pipeline.mjs` — mirror

**Produces:**
- `condition_themes` array on the `nearby` section: `Array<{ theme: string; examples: Array<{ reference: string; address: string; summary: string }> }>`
- Deep-dive phase replaced with a single AI call that extracts themes from conditions data

**Interfaces:**
- Consumes: precedent items from Task 2
- Consumes: `deps.readPrecedentDocument` (repurposed) or `deps.synthesise` for theme extraction

- [ ] **Step 1:** Create a new prompt `CONDITION_THEMES_PROMPT` that takes an array of precedent applications with their conditions/decision summaries and returns themed groups:

```typescript
const CONDITION_THEMES_PROMPT = `You are given nearby planning applications with their conditions and outcomes.
Extract the 3-6 most common condition THEMES with specific examples.

Return JSON: { "themes": [{ "theme": "short label", "examples": [{ "reference": "ref", "address": "addr", "summary": "one line about this condition" }] }] }

Also extract:
- "appeal_details": [{ "reference", "address", "proposal", "council_decision", "appeal_outcome", "what_changed" }]
- "fi_themes": [{ "theme": "what was requested", "count": N, "examples": [{ "reference", "address" }] }]

Only include themes with 2+ examples. Be specific — name the actual condition, not a vague category.`;
```

- [ ] **Step 2:** In the precedent enrichment phase of `generateReport`, replace the deep-dive loop with a single AI call. Gather the precedent data (descriptions, statuses, appeal references, F.I. dates) into a JSON evidence pack and call `deps.synthesise` (or a new dedicated call) with `CONDITION_THEMES_PROMPT`.

- [ ] **Step 3:** Parse the AI response and merge themes, appeal details, and F.I. themes into the `nearby` section data.

- [ ] **Step 4:** Mirror in `api/_preplan/pipeline.mjs`.

- [ ] **Step 5:** Commit: "Replace deep dives with condition theme extraction via single AI call"

---

### Task 4: Update AI prompts — at_a_glance + revised synthesis

**Files:**
- Modify: `server/src/preplan/report.ts` — add at_a_glance call, revise synthesis prompt
- Modify: `api/_preplan/pipeline.mjs` — mirror

**Produces:**
- `"at_a_glance"` yielded as a section (string) after site_constraints resolves
- Revised `PREPLAN_SYNTHESIS_PROMPT` that references sections without duplicating them

- [ ] **Step 1:** Add an `AT_A_GLANCE_PROMPT`:

```typescript
const AT_A_GLANCE_PROMPT = `Write a 2-3 sentence summary of this site for someone considering a planning application.
Cover: what the zoning allows, any notable constraints (flood, heritage, RZLT, derelict), and the pattern of nearby planning decisions.
Be factual and specific. Do not give advice or predict outcomes.`;
```

- [ ] **Step 2:** After site_constraints and precedent sections resolve, call `deps.synthesise(AT_A_GLANCE_PROMPT, evidencePack)` with a compact evidence pack (designations list + precedent summary counts). Yield as `{ type: "section", name: "at_a_glance", data: text }`.

- [ ] **Step 3:** Revise `PREPLAN_SYNTHESIS_PROMPT` — remove the **Overview** and **Site constraints** headings (covered by at_a_glance and site_constraints sections). Focus on:
  - **What nearby decisions show** — synthesis of the precedent pattern
  - **Condition themes to expect** — reference the themes section
  - **Worth checking before applying** — practical next steps

  Drop the 5-heading structure. Allow 200-400 words (shorter than before — less to duplicate).

- [ ] **Step 4:** Mirror in `api/_preplan/pipeline.mjs`.

- [ ] **Step 5:** Commit: "Add at-a-glance summary, revise synthesis prompt to avoid duplication"

---

### Task 5: Rewrite ReportView.tsx

**Files:**
- Modify: `web/src/components/ReportView.tsx` — full section rewrite

**Interfaces:**
- Consumes: new section shapes from Tasks 1-4:
  - `site_constraints: { designations: DesignationsSection, heritage: HeritageSection, flood: FloodGroundSection }`
  - `address_history: { items: ScoredPrecedent[] }`
  - `nearby: { items: ScoredPrecedent[], condition_themes: Theme[], appeals: Appeal[], fi_themes: FITheme[], officers: Officer[] }`
  - `at_a_glance: string`
  - `area_stats` (unchanged)
  - `local_plan` (unchanged)

- [ ] **Step 1:** Update section type interfaces at the top of the file to match new section shapes.

- [ ] **Step 2:** Rewrite the render order:
  1. Property header (unchanged)
  2. At a glance — render `s.at_a_glance` as a styled paragraph with disclaimer
  3. Site constraints — render as a compact `<dl>` or table with check/result/meaning rows, merging designations + flood + heritage data
  4. Planning history at this address — render `s.address_history.items` as compact cards with reference, status, description, commencement status, expiry
  5. What happened nearby — render `s.nearby.items` grouped by `work_type` (use `WORK_TYPE_LABELS`), then condition themes with cited examples, appeals subsection, F.I. themes, case officers line
  6. How this area decides (unchanged — render `s.area_stats`)
  7. Considerations — render narrative with dev plan link, no overview extraction (that's now at_a_glance)

- [ ] **Step 3:** Build the `SiteConstraints` component — a `<dl>` with rows for each check. Merge designation hits, flood result, groundwater, radon, and heritage items into a flat list. For SMR items, use `name` (which is `CLASSDESC` from the data) as the primary label, not the ref code.

- [ ] **Step 4:** Build the `AddressHistory` component — compact cards for each application. Show commencement status from `commencement_date` field. Show "expired" if `decision_date` + 5 years < now and status is granted.

- [ ] **Step 5:** Build the `NearbyPrecedents` component:
  - Group items by `work_type`, render each group with a heading from `WORK_TYPE_LABELS`
  - Render compact cards within each group (briefer than address history — no conditions unless refused/appealed)
  - Render condition themes as theme headings with indented example rows
  - Render appeals subsection with full context per appeal
  - Render F.I. themes
  - Render case officers as a single paragraph

- [ ] **Step 6:** Remove the old `splitNarrative` helper and the deep-dives rendering code. The Considerations section now renders the narrative directly without extracting an overview.

- [ ] **Step 7:** Handle backward compatibility — if old-format sections arrive (e.g. `designations` instead of `site_constraints`), fall back gracefully so in-flight reports don't break.

- [ ] **Step 8:** Commit: "Rewrite ReportView for redesigned report structure"

---

### Task 6: Integration test and polish

**Files:**
- Modify: any files with issues found during testing

- [ ] **Step 1:** Generate a test report on the deployed site. Verify all sections render correctly.

- [ ] **Step 2:** Check that the `rural_housing` section (Vercel-only) still renders when applicable — it should be unaffected by the restructure.

- [ ] **Step 3:** Verify print layout (`Cmd+P`) still produces a clean result — the merged sections and new layout should print well.

- [ ] **Step 4:** Fix any rendering issues, type errors, or missing data.

- [ ] **Step 5:** Commit and push to deploy.
