# Planning Agent Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A conversational agent tab where users ask natural-language questions about planning applications and get streamed, evidence-based answers with inline application cards and map pins.

**Architecture:** Claude Sonnet tool-use loop on the server (`POST /api/agent`, SSE stream). Tools are thin wrappers over existing server functions (search, conditions, zoning, flood, appeals, documents) plus a data-derived geocoder. The frontend adds an "Ask" tab whose chat thread renders streamed text with `[app:id:N]` tokens replaced by application cards; referenced applications appear as map pins. Per project convention, the agent is mirrored in the dependency-free Vercel handler `api/index.mjs`.

**Tech Stack:** TypeScript, Fastify 4, better-sqlite3, Anthropic Messages API (streaming, model `claude-sonnet-5`), Vite + React 18, SSE.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-07-20-planning-agent-design.md`.
- Guardrail (PRD §3.3): present evidence, never predict outcomes or give legal advice.
- De-emphasise boilerplate grant conditions (construction hours, noise, tidiness); highlight substantive ones (size reductions, design changes, glazing, setbacks).
- Every backend behaviour must exist in BOTH `server/src/*.ts` (Fastify) and `api/index.mjs` (Vercel serverless, dependency-free plain JS).
- Model: `claude-sonnet-5`, quality over cost/latency. Max 12 tool-loop turns, `max_tokens: 4000` per model call.
- `ask_user` from the spec is implemented as a plain-text assistant reply (system prompt instructs the model to ask and stop) — functionally identical, no tool plumbing.
- Local test caveat: anything importing `better-sqlite3` at runtime fails locally (native dep missing). Unit-test pure functions and injectable loops only; DB-backed behaviour is verified by typecheck + Vercel deploy. `search.test.ts` already fails locally — pre-existing, ignore.
- Kildare/DLR conditions text is not fetchable via Agile for Kildare (eplanning council) — `get_conditions` must return a structured "not available" note for non-agile councils rather than erroring.
- Comments: minimal, only for non-obvious reasoning, 2-3 lines max (org policy).

## File Structure

| File | Responsibility |
|------|----------------|
| `server/src/agent/tools.ts` | Anthropic tool schemas + pure input→`SearchFilters` mapping + `bboxAround` |
| `server/src/agent/prompt.ts` | System prompt (planning context, guardrails, condition triage, `[app:id:N]` format) |
| `server/src/agent/execute.ts` | `buildToolExecutor(db)` — dispatch tool calls to existing server functions |
| `server/src/agent/agent.ts` | `runAgent()` async generator: Anthropic streaming call, SSE parse, tool loop |
| `server/src/api.ts` (modify) | `POST /api/agent` SSE route |
| `web/src/agentApi.ts` | SSE client + shared chat/event types |
| `web/src/components/ChatPanel.tsx` | Chat thread UI, token→card rendering, tool status lines |
| `web/src/App.tsx` (modify) | Search/Ask mode tabs; agent-referenced apps → map pins |
| `web/src/styles.css` (modify) | Chat styles |
| `api/index.mjs` (modify) | Serverless mirror of tools/prompt/loop/route |
| `scripts/build-vercel.mjs` (verify/modify) | Ensure function config allows response streaming |

---

### Task 1: Tool schemas and filter mapping

**Files:**
- Create: `server/src/agent/tools.ts`
- Test: `server/test/agent-tools.test.ts`

**Interfaces:**
- Consumes: `SearchFilters` from `server/src/search.ts`
- Produces: `AGENT_TOOLS: AnthropicTool[]`, `searchFiltersFromToolInput(input: Record<string, unknown>): SearchFilters`, `bboxAround(lat: number, lng: number, km: number): [number, number, number, number]`

- [ ] **Step 1: Write the failing test**

```ts
// server/test/agent-tools.test.ts
import { describe, expect, it } from "vitest";
import { AGENT_TOOLS, bboxAround, searchFiltersFromToolInput } from "../src/agent/tools.js";

describe("AGENT_TOOLS", () => {
  it("defines the eight tools from the spec", () => {
    expect(AGENT_TOOLS.map((t) => t.name).sort()).toEqual([
      "geocode_location",
      "get_appeal",
      "get_application_detail",
      "get_conditions",
      "get_documents",
      "get_flood_risk",
      "get_zoning",
      "search_applications",
    ]);
  });

  it("every tool has a description and object input schema", () => {
    for (const t of AGENT_TOOLS) {
      expect(t.description.length).toBeGreaterThan(20);
      expect(t.input_schema.type).toBe("object");
    }
  });
});

describe("bboxAround", () => {
  it("returns [w,s,e,n] roughly km-sized around the point", () => {
    const [w, s, e, n] = bboxAround(53.38, -6.59, 1);
    expect(w).toBeLessThan(-6.59);
    expect(e).toBeGreaterThan(-6.59);
    expect(s).toBeLessThan(53.38);
    expect(n).toBeGreaterThan(53.38);
    // 1km ≈ 0.009 degrees latitude
    expect(n - s).toBeCloseTo(0.018, 2);
  });
});

describe("searchFiltersFromToolInput", () => {
  it("maps a full input", () => {
    const f = searchFiltersFromToolInput({
      query: "extension",
      statuses: ["granted", "refused"],
      domestic_only: true,
      appealed_only: false,
      near: { lat: 53.38, lng: -6.59 },
      radius_km: 2,
      received_from: "2022-01-01",
      limit: 10,
    });
    expect(f.q).toBe("extension");
    expect(f.statuses).toEqual(["granted", "refused"]);
    expect(f.domesticOnly).toBe(true);
    expect(f.appealedOnly).toBe(false);
    expect(f.near).toEqual({ lat: 53.38, lng: -6.59 });
    expect(f.bbox).toBeDefined();
    expect(f.sort).toBe("distance");
    expect(f.receivedFrom).toBe("2022-01-01");
    expect(f.limit).toBe(10);
  });

  it("defaults: relevance sort without near, limit capped at 50", () => {
    const f = searchFiltersFromToolInput({ query: "shed", limit: 500 });
    expect(f.sort).toBe("relevance");
    expect(f.bbox).toBeUndefined();
    expect(f.limit).toBe(50);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && npx vitest run test/agent-tools.test.ts`
Expected: FAIL — cannot resolve `../src/agent/tools.js`

- [ ] **Step 3: Implement `server/src/agent/tools.ts`**

```ts
import type { SearchFilters } from "../search.js";

export interface AnthropicTool {
  name: string;
  description: string;
  input_schema: { type: "object"; properties: Record<string, unknown>; required?: string[] };
}

const STATUSES = [
  "pending", "further_info", "granted", "refused",
  "withdrawn", "invalid", "incomplete", "appealed",
];

export const AGENT_TOOLS: AnthropicTool[] = [
  {
    name: "search_applications",
    description:
      "Search planning applications across Dublin City, Fingal, Dún Laoghaire-Rathdown, South Dublin " +
      "and Kildare. Full-text over address, planning reference, applicant and description, with filters. " +
      "Returns application summaries including id, status, decision, dates and coordinates. " +
      "Use near+radius_km to scope to an area (results sorted nearest first).",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Keywords, e.g. 'two storey extension'" },
        statuses: { type: "array", items: { type: "string", enum: STATUSES } },
        domestic_only: { type: "boolean", description: "Restrict to likely-domestic applications" },
        appealed_only: { type: "boolean", description: "Only applications that went to appeal" },
        near: {
          type: "object",
          properties: { lat: { type: "number" }, lng: { type: "number" } },
          required: ["lat", "lng"],
        },
        radius_km: { type: "number", description: "Search radius in km, used with near" },
        received_from: { type: "string", description: "ISO date lower bound on received date" },
        received_to: { type: "string", description: "ISO date upper bound on received date" },
        limit: { type: "number", description: "Max results, default 25, cap 50" },
      },
    },
  },
  {
    name: "get_application_detail",
    description:
      "Full register detail for one application by id: description, applicant, all dates, decision, " +
      "appeal fields, units, floor area, portal link.",
    input_schema: {
      type: "object",
      properties: { application_id: { type: "number" } },
      required: ["application_id"],
    },
  },
  {
    name: "get_conditions",
    description:
      "Conditions of grant or reasons for refusal for one application. Only available for the four " +
      "Dublin (agile) councils; for Kildare the register holds the outcome but not the conditions text. " +
      "Codes: C=condition, R=refusal reason, D=further-info directive, I=informative, N=note.",
    input_schema: {
      type: "object",
      properties: { application_id: { type: "number" } },
      required: ["application_id"],
    },
  },
  {
    name: "get_zoning",
    description:
      "Land-use zoning at an application's location (zone code, name, generalised type) from the " +
      "national Generalised Zoning dataset. Use to explain what development the area is designated for.",
    input_schema: {
      type: "object",
      properties: { application_id: { type: "number" } },
      required: ["application_id"],
    },
  },
  {
    name: "get_flood_risk",
    description: "Indicative flood risk at an application's location (OPW flood maps).",
    input_schema: {
      type: "object",
      properties: { application_id: { type: "number" } },
      required: ["application_id"],
    },
  },
  {
    name: "get_appeal",
    description:
      "Appeal case details from An Coimisiún Pleanála for an application that was appealed: " +
      "parties, status, decision and case documents. Only call when the application has an appeal reference.",
    input_schema: {
      type: "object",
      properties: { application_id: { type: "number" } },
      required: ["application_id"],
    },
  },
  {
    name: "get_documents",
    description:
      "List the scanned files / documents the council holds for an application (drawings, reports, " +
      "decision orders), with titles. Slow: only call when the user asks about documents.",
    input_schema: {
      type: "object",
      properties: { application_id: { type: "number" } },
      required: ["application_id"],
    },
  },
  {
    name: "geocode_location",
    description:
      "Resolve a placename, street or eircode within the covered counties to approximate coordinates " +
      "and the local authority, by matching addresses in the planning register. Returns null when no match — " +
      "then ask the user for a more specific address.",
    input_schema: {
      type: "object",
      properties: { location: { type: "string" } },
      required: ["location"],
    },
  },
];

export function bboxAround(lat: number, lng: number, km: number): [number, number, number, number] {
  const dLat = km / 111.32;
  const dLng = km / (111.32 * Math.cos((lat * Math.PI) / 180));
  return [lng - dLng, lat - dLat, lng + dLng, lat + dLat];
}

export function searchFiltersFromToolInput(input: Record<string, unknown>): SearchFilters {
  const nearRaw = input.near as { lat?: unknown; lng?: unknown } | undefined;
  const lat = Number(nearRaw?.lat);
  const lng = Number(nearRaw?.lng);
  const near = Number.isFinite(lat) && Number.isFinite(lng) ? { lat, lng } : undefined;
  const radius = Number(input.radius_km);
  return {
    q: typeof input.query === "string" && input.query.trim() ? input.query : undefined,
    statuses: Array.isArray(input.statuses) ? input.statuses.map(String) : undefined,
    domesticOnly: input.domestic_only === true,
    appealedOnly: input.appealed_only === true,
    receivedFrom: typeof input.received_from === "string" ? input.received_from : undefined,
    receivedTo: typeof input.received_to === "string" ? input.received_to : undefined,
    near,
    bbox: near && Number.isFinite(radius) && radius > 0 ? bboxAround(near.lat, near.lng, radius) : undefined,
    sort: near ? "distance" : "relevance",
    limit: Math.min(Number(input.limit) || 25, 50),
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && npx vitest run test/agent-tools.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add server/src/agent/tools.ts server/test/agent-tools.test.ts
git commit -m "Add planning agent tool schemas and search filter mapping"
```

---

### Task 2: System prompt

**Files:**
- Create: `server/src/agent/prompt.ts`
- Test: `server/test/agent-prompt.test.ts`

**Interfaces:**
- Produces: `SYSTEM_PROMPT: string`

- [ ] **Step 1: Write the failing test**

```ts
// server/test/agent-prompt.test.ts
import { describe, expect, it } from "vitest";
import { SYSTEM_PROMPT } from "../src/agent/prompt.js";

describe("SYSTEM_PROMPT", () => {
  it("carries the core rules", () => {
    expect(SYSTEM_PROMPT).toMatch(/\[app:id:/);            // card token format
    expect(SYSTEM_PROMPT).toMatch(/never predict/i);        // evidence-not-prediction
    expect(SYSTEM_PROMPT).toMatch(/boilerplate/i);          // condition triage
    expect(SYSTEM_PROMPT).toMatch(/eircode/i);              // clarify vague locations
    expect(SYSTEM_PROMPT).toMatch(/An Coimisiún Pleanála/); // appeals context
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && npx vitest run test/agent-prompt.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement `server/src/agent/prompt.ts`**

```ts
export const SYSTEM_PROMPT = `You are the PlanView planning agent. You help people in Ireland understand what has \
happened with planning applications so they can form their own picture — typically a homeowner wondering about an \
extension, rebuild or new dwelling, or a professional researching an area.

COVERAGE: Dublin City, Fingal, Dún Laoghaire-Rathdown, South Dublin and Kildare county councils. Data comes from the \
statutory planning registers. Appeals are decided nationally by An Coimisiún Pleanála (formerly An Bord Pleanála) and \
a decided appeal replaces the council's decision.

EVIDENCE, NOT PREDICTIONS: You present what the register shows — grant/refusal outcomes on comparable applications, \
the conditions imposed, refusal reasons, appeal outcomes, zoning. You never predict whether the user would get \
permission, never estimate probabilities, and never give legal or professional advice. Let the evidence speak; the \
user draws the conclusion. If asked "will I get permission", explain you can only show what happened in comparable \
cases nearby.

CLARIFY VAGUE LOCATIONS: A townland or town name alone ("Maynooth") is usually too broad — zoning and comparables \
differ street to street. When the location is vague, ask one short clarifying question requesting a more specific \
address, street or eircode, and stop. When it is specific enough, proceed without nagging.

RESEARCH APPROACH: Typically geocode_location first, then search_applications scoped near those coordinates with \
keywords matching the user's proposal, filtered to likely-domestic where relevant. Then examine the most comparable \
results: get_conditions on granted ones, get_conditions on refused ones (reasons), get_appeal on any with an appeal \
reference, and get_zoning on the closest application to describe the area's designation. Fetch conditions for at most \
5 applications per reply. Prefer recent applications (last ~5 years) when plenty exist.

CONDITIONS — SUBSTANTIVE VS BOILERPLATE: Most grants carry near-identical boilerplate conditions (construction hours, \
noise limits, site tidiness, development contributions, water/drainage standards). Do not present these as a pattern — \
mention at most in passing. Emphasise substantive conditions that changed what could be built: omit or reduce part of \
the works, ridge-height reductions, obscure glazing or fixed windows, matching materials, setbacks from boundaries, \
removal of permitted-development rights.

ZONING: When zoning is relevant to the question, name the zone and what it is designated for, and relate it to the \
proposal type (e.g. residential extensions in an established-residential zone are routine matters of amenity and design).

FORMAT: Markdown. Short paragraphs and bullet lists, no long essays. When you reference a specific application, put a \
token [app:id:<id>] on its own line (or several tokens on one line) where its card should appear — the interface \
renders these as clickable cards. Always include tokens for the applications you discuss. Do not fabricate ids; only \
use ids returned by tools. Do not put the token inside a sentence.

If a tool returns an error or nothing, say plainly what could not be checked rather than guessing.`;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && npx vitest run test/agent-prompt.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add server/src/agent/prompt.ts server/test/agent-prompt.test.ts
git commit -m "Add planning agent system prompt"
```

---

### Task 3: Tool executor

**Files:**
- Create: `server/src/agent/execute.ts`
- Test: `server/test/agent-execute.test.ts`

**Interfaces:**
- Consumes: `search(db, filters)` from `../search.js`; `AGILE_CLIENT_BY_AUTHORITY`, `fetchAgileConditions(authorityId, sourceUrl, reference)` from `../agile.js`; `fetchZoning(lat, lng)`; `fetchFlood(lat, lng)`; `abpCaseUrl(ref)`, `fetchAppealCase(caseUrl)` from `../abp.js`; `deriveScannedFilesUrl(authorityId, sourceUrl, reference)`, `fetchScannedFileList(listUrl)` from `../documents.js`; `STATUS_LABELS` from `../normalize.js`; `searchFiltersFromToolInput` from `./tools.js`
- Produces: `buildToolExecutor(db: Database.Database, deps?: Partial<ToolDeps>): (name: string, input: Record<string, unknown>) => Promise<unknown>` and `toolAppSummary(row): AgentAppSummary` (pure row-trimmer)

The executor takes an injectable `deps` object (defaulting to the real functions) so tests can run without better-sqlite3 or network.

- [ ] **Step 1: Write the failing test**

```ts
// server/test/agent-execute.test.ts
import { describe, expect, it } from "vitest";
import { buildToolExecutor, toolAppSummary } from "../src/agent/execute.js";

const ROW = {
  id: 42, authority_id: "kildare", planning_reference: "23/123",
  description: "Two storey rear extension", status: "granted",
  application_type: "permission", is_domestic_guess: 1,
  received_date: "2023-02-01", decision: "Grant Permission", decision_date: "2023-05-01",
  address_text: "1 Main St, Maynooth", lat: 53.38, lng: -6.59,
  appeal_reference: null,
};

const fakeDb = {
  prepare: () => ({ get: (id: number) => (id === 42 ? ROW : undefined) }),
} as never;

function exec(deps: Record<string, unknown>) {
  return buildToolExecutor(fakeDb, deps as never);
}

describe("toolAppSummary", () => {
  it("trims a row to the summary shape with a status label", () => {
    const s = toolAppSummary(ROW as never);
    expect(s).toMatchObject({
      id: 42, planning_reference: "23/123", status: "granted",
      status_label: "Granted", address_text: "1 Main St, Maynooth", lat: 53.38,
    });
    expect(s).not.toHaveProperty("geom_polygon");
  });
});

describe("buildToolExecutor", () => {
  it("search_applications maps input and returns summaries", async () => {
    const run = exec({
      search: (_db: never, f: { q?: string }) => {
        expect(f.q).toBe("extension");
        return { results: [ROW], total: 1, fuzzy: false };
      },
    });
    const out = (await run("search_applications", { query: "extension" })) as {
      total: number; results: Array<{ id: number }>;
    };
    expect(out.total).toBe(1);
    expect(out.results[0].id).toBe(42);
  });

  it("get_conditions reports unavailable for non-agile councils", async () => {
    const run = exec({});
    const out = (await run("get_conditions", { application_id: 42 })) as { available: boolean };
    expect(out.available).toBe(false);
  });

  it("get_appeal explains when there is no appeal", async () => {
    const run = exec({});
    const out = (await run("get_appeal", { application_id: 42 })) as { error: string };
    expect(out.error).toMatch(/no appeal/i);
  });

  it("geocode_location returns the first located search hit", async () => {
    const run = exec({
      search: () => ({ results: [ROW], total: 1, fuzzy: true }),
    });
    const out = (await run("geocode_location", { location: "maynooth" })) as {
      lat: number; authority_id: string; confidence: string;
    };
    expect(out.lat).toBe(53.38);
    expect(out.authority_id).toBe("kildare");
    expect(out.confidence).toBe("approximate");
  });

  it("unknown tool → error object, not a throw", async () => {
    const run = exec({});
    const out = (await run("no_such_tool", {})) as { error: string };
    expect(out.error).toMatch(/unknown tool/i);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && npx vitest run test/agent-execute.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement `server/src/agent/execute.ts`**

```ts
import type Database from "better-sqlite3";
import { search as realSearch } from "../search.js";
import { AGILE_CLIENT_BY_AUTHORITY, fetchAgileConditions } from "../agile.js";
import { fetchZoning } from "../zoning.js";
import { fetchFlood } from "../flood.js";
import { abpCaseUrl, fetchAppealCase } from "../abp.js";
import { deriveScannedFilesUrl, fetchScannedFileList } from "../documents.js";
import { STATUS_LABELS } from "../normalize.js";
import { searchFiltersFromToolInput } from "./tools.js";

export interface ToolDeps {
  search: typeof realSearch;
  fetchAgileConditions: typeof fetchAgileConditions;
  fetchZoning: typeof fetchZoning;
  fetchFlood: typeof fetchFlood;
  fetchAppealCase: typeof fetchAppealCase;
  fetchScannedFileList: typeof fetchScannedFileList;
}

const REAL_DEPS: ToolDeps = {
  search: realSearch,
  fetchAgileConditions,
  fetchZoning,
  fetchFlood,
  fetchAppealCase,
  fetchScannedFileList,
};

export interface AgentAppSummary {
  id: number;
  authority_id: string;
  planning_reference: string;
  description: string | null;
  status: string;
  status_label: string;
  application_type: string | null;
  is_domestic_guess: boolean;
  received_date: string | null;
  decision: string | null;
  decision_date: string | null;
  address_text: string | null;
  lat: number | null;
  lng: number | null;
  appeal_reference?: string | null;
}

export function toolAppSummary(row: Record<string, unknown>): AgentAppSummary {
  return {
    id: Number(row.id),
    authority_id: String(row.authority_id),
    planning_reference: String(row.planning_reference),
    description: (row.description as string | null) ?? null,
    status: String(row.status),
    status_label: STATUS_LABELS[row.status as keyof typeof STATUS_LABELS] ?? String(row.status),
    application_type: (row.application_type as string | null) ?? null,
    is_domestic_guess: Boolean(row.is_domestic_guess),
    received_date: (row.received_date as string | null) ?? null,
    decision: (row.decision as string | null) ?? null,
    decision_date: (row.decision_date as string | null) ?? null,
    address_text: (row.address_text as string | null) ?? null,
    lat: (row.lat as number | null) ?? null,
    lng: (row.lng as number | null) ?? null,
    appeal_reference: (row.appeal_reference as string | null) ?? null,
  };
}

export function buildToolExecutor(db: Database.Database, deps: Partial<ToolDeps> = {}) {
  const d = { ...REAL_DEPS, ...deps };

  const getRow = (input: Record<string, unknown>): Record<string, unknown> | null => {
    const id = Number(input.application_id);
    if (!Number.isFinite(id)) return null;
    return (db.prepare("SELECT * FROM applications WHERE id = ?").get(id) as
      | Record<string, unknown>
      | undefined) ?? null;
  };

  return async (name: string, input: Record<string, unknown>): Promise<unknown> => {
    switch (name) {
      case "search_applications": {
        const { results, total, fuzzy } = d.search(db, searchFiltersFromToolInput(input));
        return { total, fuzzy, results: results.map((r) => toolAppSummary(r as never)) };
      }
      case "get_application_detail": {
        const row = getRow(input);
        if (!row) return { error: "Application not found" };
        const { geom_polygon: _g, ai_summary: _s, ...rest } = row;
        return rest;
      }
      case "get_conditions": {
        const row = getRow(input);
        if (!row) return { error: "Application not found" };
        const authorityId = String(row.authority_id);
        if (!AGILE_CLIENT_BY_AUTHORITY[authorityId]) {
          return {
            available: false,
            note: "Conditions text is not published in a fetchable form by this council; the register holds only the decision outcome.",
          };
        }
        const conditions = await d.fetchAgileConditions(
          authorityId,
          (row.source_url as string | null) ?? null,
          String(row.planning_reference)
        );
        return conditions ?? { available: false, note: "No conditions returned by the council system." };
      }
      case "get_zoning": {
        const row = getRow(input);
        if (!row) return { error: "Application not found" };
        if (row.lat == null || row.lng == null) return { error: "Application has no coordinates" };
        return (await d.fetchZoning(Number(row.lat), Number(row.lng))) ?? { error: "Zoning lookup failed" };
      }
      case "get_flood_risk": {
        const row = getRow(input);
        if (!row) return { error: "Application not found" };
        if (row.lat == null || row.lng == null) return { error: "Application has no coordinates" };
        return (await d.fetchFlood(Number(row.lat), Number(row.lng))) ?? { error: "Flood lookup failed" };
      }
      case "get_appeal": {
        const row = getRow(input);
        if (!row) return { error: "Application not found" };
        const ref = (row.appeal_reference as string | null) ?? null;
        const url = abpCaseUrl(ref);
        if (!ref || !url) return { error: "No appeal on this application" };
        const kase = await d.fetchAppealCase(url);
        return kase ?? { error: "Could not load the appeal case page", case_url: url };
      }
      case "get_documents": {
        const row = getRow(input);
        if (!row) return { error: "Application not found" };
        const listUrl = deriveScannedFilesUrl(
          String(row.authority_id),
          (row.source_url as string | null) ?? null,
          (row.planning_reference as string | null) ?? null
        );
        if (!listUrl) return { error: "No document listing available for this council" };
        const files = await d.fetchScannedFileList(listUrl);
        if (!files) return { error: "Could not load the document list" };
        return { count: files.length, files: files.map((f) => ({ title: f.title })) };
      }
      case "geocode_location": {
        const q = typeof input.location === "string" ? input.location.trim() : "";
        if (!q) return { error: "location is required" };
        const { results, fuzzy } = d.search(db, { q, limit: 5, sort: "relevance" });
        const hit = results.find((r) => (r as { lat?: number | null }).lat != null);
        if (!hit) return null;
        const s = toolAppSummary(hit as never);
        return {
          matched_address: s.address_text ?? s.planning_reference,
          lat: s.lat,
          lng: s.lng,
          authority_id: s.authority_id,
          confidence: fuzzy ? "approximate" : "exact",
        };
      }
      default:
        return { error: `Unknown tool: ${name}` };
    }
  };
}
```

Note: check `ScannedFile`'s actual fields in `server/src/documents.ts` when implementing — if `title` is named differently (e.g. `name`), adapt the `get_documents` mapping and test to match.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && npx vitest run test/agent-execute.test.ts`
Expected: PASS

- [ ] **Step 5: Typecheck**

Run: `cd server && npx tsc --noEmit`
Expected: no errors

- [ ] **Step 6: Commit**

```bash
git add server/src/agent/execute.ts server/test/agent-execute.test.ts
git commit -m "Add planning agent tool executor over existing server functions"
```

---

### Task 4: Agent loop with Anthropic streaming

**Files:**
- Create: `server/src/agent/agent.ts`
- Test: `server/test/agent-loop.test.ts`

**Interfaces:**
- Consumes: `AGENT_TOOLS` from `./tools.js`, `SYSTEM_PROMPT` from `./prompt.js`
- Produces:
  - `type AgentEvent = { type: "text"; text: string } | { type: "tool_start"; name: string; input: unknown } | { type: "tool_result"; name: string; result: unknown } | { type: "error"; message: string } | { type: "done" }`
  - `runAgent(opts: { messages: ChatTurn[]; executeTool: (name: string, input: Record<string, unknown>) => Promise<unknown>; fetchImpl?: typeof fetch; apiKey?: string; model?: string }): AsyncGenerator<AgentEvent>`
  - `type ChatTurn = { role: "user" | "assistant"; content: string }`

- [ ] **Step 1: Write the failing test**

The test scripts two fake Anthropic SSE responses: first a tool_use turn, then a final text turn.

```ts
// server/test/agent-loop.test.ts
import { describe, expect, it } from "vitest";
import { runAgent, type AgentEvent } from "../src/agent/agent.js";

function sse(events: Array<Record<string, unknown>>): Response {
  const body = events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join("");
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

const TOOL_TURN = sse([
  { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "tu_1", name: "search_applications", input: {} } },
  { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"query":"extension"}' } },
  { type: "content_block_stop", index: 0 },
  { type: "message_delta", delta: { stop_reason: "tool_use" } },
  { type: "message_stop" },
]);

const TEXT_TURN = sse([
  { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
  { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "I found " } },
  { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "3 extensions." } },
  { type: "content_block_stop", index: 0 },
  { type: "message_delta", delta: { stop_reason: "end_turn" } },
  { type: "message_stop" },
]);

describe("runAgent", () => {
  it("runs the tool loop and streams text", async () => {
    const turns = [TOOL_TURN, TEXT_TURN];
    const bodies: Array<Record<string, unknown>> = [];
    const fetchImpl = (async (_url: unknown, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)));
      return turns.shift()!;
    }) as typeof fetch;

    const events: AgentEvent[] = [];
    for await (const ev of runAgent({
      messages: [{ role: "user", content: "extensions near me?" }],
      executeTool: async (name, input) => ({ echoed: { name, input } }),
      fetchImpl,
      apiKey: "test-key",
    })) {
      events.push(ev);
    }

    const types = events.map((e) => e.type);
    expect(types).toEqual(["tool_start", "tool_result", "text", "text", "done"]);
    const start = events[0] as { name: string; input: { query: string } };
    expect(start.name).toBe("search_applications");
    expect(start.input.query).toBe("extension");
    // Second API call must carry the assistant tool_use turn + tool_result
    const second = bodies[1] as { messages: Array<{ role: string }> };
    expect(second.messages.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
  });

  it("yields error when there is no API key", async () => {
    const events: AgentEvent[] = [];
    for await (const ev of runAgent({
      messages: [{ role: "user", content: "hi" }],
      executeTool: async () => ({}),
      apiKey: "",
    })) {
      events.push(ev);
    }
    expect(events[0].type).toBe("error");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && npx vitest run test/agent-loop.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement `server/src/agent/agent.ts`**

```ts
import { AGENT_TOOLS } from "./tools.js";
import { SYSTEM_PROMPT } from "./prompt.js";

const MODEL = "claude-sonnet-5";
const MAX_TURNS = 12;
const MAX_TOKENS = 4000;
const TOOL_RESULT_CHAR_CAP = 30_000;

export type ChatTurn = { role: "user" | "assistant"; content: string };

export type AgentEvent =
  | { type: "text"; text: string }
  | { type: "tool_start"; name: string; input: unknown }
  | { type: "tool_result"; name: string; result: unknown }
  | { type: "error"; message: string }
  | { type: "done" };

type ContentBlock =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> };

interface StreamEvent {
  type: string;
  index?: number;
  content_block?: { type: string; id?: string; name?: string; text?: string };
  delta?: { type?: string; text?: string; partial_json?: string; stop_reason?: string };
}

async function* parseSse(body: ReadableStream<Uint8Array>): AsyncGenerator<StreamEvent> {
  const decoder = new TextDecoder();
  let buf = "";
  for await (const chunk of body as unknown as AsyncIterable<Uint8Array>) {
    buf += decoder.decode(chunk, { stream: true });
    let i;
    while ((i = buf.indexOf("\n\n")) >= 0) {
      const frame = buf.slice(0, i);
      buf = buf.slice(i + 2);
      const data = frame.split("\n").find((l) => l.startsWith("data: "));
      if (data) yield JSON.parse(data.slice(6)) as StreamEvent;
    }
  }
}

export interface RunAgentOptions {
  messages: ChatTurn[];
  executeTool: (name: string, input: Record<string, unknown>) => Promise<unknown>;
  fetchImpl?: typeof fetch;
  apiKey?: string;
  model?: string;
}

export async function* runAgent(opts: RunAgentOptions): AsyncGenerator<AgentEvent> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const apiKey = opts.apiKey ?? process.env.ANTHROPIC_API_KEY ?? "";
  if (!apiKey) {
    yield { type: "error", message: "The agent is not configured on this deployment (missing API key)." };
    yield { type: "done" };
    return;
  }

  // Anthropic-format message list; grows with tool_use / tool_result turns.
  const msgs: Array<{ role: "user" | "assistant"; content: unknown }> = opts.messages.map((m) => ({
    role: m.role,
    content: m.content,
  }));

  for (let turn = 0; turn < MAX_TURNS; turn++) {
    let res: Response;
    try {
      res = await fetchImpl("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: opts.model ?? MODEL,
          max_tokens: MAX_TOKENS,
          stream: true,
          system: SYSTEM_PROMPT,
          tools: AGENT_TOOLS,
          messages: msgs,
        }),
      });
    } catch {
      yield { type: "error", message: "Could not reach the AI service." };
      yield { type: "done" };
      return;
    }
    if (!res.ok || !res.body) {
      yield { type: "error", message: `AI service error (${res.status}).` };
      yield { type: "done" };
      return;
    }

    const blocks: ContentBlock[] = [];
    const partialJson: Record<number, string> = {};
    let stopReason: string | null = null;

    for await (const ev of parseSse(res.body)) {
      if (ev.type === "content_block_start" && ev.content_block && ev.index !== undefined) {
        if (ev.content_block.type === "text") {
          blocks[ev.index] = { type: "text", text: ev.content_block.text ?? "" };
        } else if (ev.content_block.type === "tool_use") {
          blocks[ev.index] = {
            type: "tool_use",
            id: ev.content_block.id ?? "",
            name: ev.content_block.name ?? "",
            input: {},
          };
          partialJson[ev.index] = "";
        }
      } else if (ev.type === "content_block_delta" && ev.delta && ev.index !== undefined) {
        const block = blocks[ev.index];
        if (ev.delta.type === "text_delta" && block?.type === "text" && ev.delta.text) {
          block.text += ev.delta.text;
          yield { type: "text", text: ev.delta.text };
        } else if (ev.delta.type === "input_json_delta" && block?.type === "tool_use") {
          partialJson[ev.index] += ev.delta.partial_json ?? "";
        }
      } else if (ev.type === "content_block_stop" && ev.index !== undefined) {
        const block = blocks[ev.index];
        if (block?.type === "tool_use" && partialJson[ev.index]) {
          try {
            block.input = JSON.parse(partialJson[ev.index]);
          } catch {
            block.input = {};
          }
        }
      } else if (ev.type === "message_delta" && ev.delta?.stop_reason) {
        stopReason = ev.delta.stop_reason;
      }
    }

    const toolUses = blocks.filter((b): b is Extract<ContentBlock, { type: "tool_use" }> => b?.type === "tool_use");
    if (stopReason === "tool_use" && toolUses.length) {
      msgs.push({ role: "assistant", content: blocks.filter(Boolean) });
      const results: unknown[] = [];
      for (const tu of toolUses) {
        yield { type: "tool_start", name: tu.name, input: tu.input };
        let out: unknown;
        try {
          out = await opts.executeTool(tu.name, tu.input);
        } catch (e) {
          out = { error: `Tool failed: ${e instanceof Error ? e.message : String(e)}` };
        }
        yield { type: "tool_result", name: tu.name, result: out };
        results.push({
          type: "tool_result",
          tool_use_id: tu.id,
          content: JSON.stringify(out ?? null).slice(0, TOOL_RESULT_CHAR_CAP),
        });
      }
      msgs.push({ role: "user", content: results });
      continue;
    }

    yield { type: "done" };
    return;
  }

  yield { type: "error", message: "The agent hit its research step limit — try a narrower question." };
  yield { type: "done" };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && npx vitest run test/agent-loop.test.ts`
Expected: PASS

- [ ] **Step 5: Typecheck and commit**

Run: `cd server && npx tsc --noEmit`
Expected: no errors

```bash
git add server/src/agent/agent.ts server/test/agent-loop.test.ts
git commit -m "Add Claude Sonnet tool-use loop with SSE streaming"
```

---

### Task 5: Fastify route `POST /api/agent`

**Files:**
- Modify: `server/src/api.ts` (add route at the end of `registerApi`, after the `/api/applications/:id/enrich` route)

**Interfaces:**
- Consumes: `runAgent`, `type ChatTurn` from `./agent/agent.js`; `buildToolExecutor` from `./agent/execute.js`
- Produces: `POST /api/agent` accepting `{ messages: ChatTurn[] }`, responding `text/event-stream` of `data: <AgentEvent JSON>\n\n` frames

- [ ] **Step 1: Add imports to `server/src/api.ts`**

```ts
import { runAgent, type ChatTurn } from "./agent/agent.js";
import { buildToolExecutor } from "./agent/execute.js";
```

- [ ] **Step 2: Add the route inside `registerApi` (after the enrich route)**

```ts
app.post("/api/agent", async (req, reply) => {
  const body = req.body as { messages?: Array<{ role?: string; content?: string }> } | null;
  const messages: ChatTurn[] = (body?.messages ?? [])
    .filter(
      (m): m is { role: "user" | "assistant"; content: string } =>
        (m.role === "user" || m.role === "assistant") &&
        typeof m.content === "string" &&
        m.content.trim().length > 0
    )
    .slice(-30);
  if (!messages.length || messages[messages.length - 1].role !== "user") {
    return reply.code(400).send({ error: "messages must end with a user message" });
  }

  reply.raw.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  const executeTool = buildToolExecutor(db);
  try {
    for await (const ev of runAgent({ messages, executeTool })) {
      reply.raw.write(`data: ${JSON.stringify(ev)}\n\n`);
    }
  } catch {
    reply.raw.write(`data: ${JSON.stringify({ type: "error", message: "Agent crashed" })}\n\n`);
  } finally {
    reply.raw.end();
  }
});
```

Note: `registerApi`'s existing signature already receives `db` — reuse whatever variable name the function uses for the Database instance (check the top of `registerApi`).

- [ ] **Step 3: Typecheck**

Run: `cd server && npx tsc --noEmit`
Expected: no errors

- [ ] **Step 4: Run full server test suite**

Run: `cd server && npx vitest run`
Expected: only the pre-existing failures (`search.test.ts` native dep, `serverless-loads.test.ts` missing bundle); all agent tests pass

- [ ] **Step 5: Commit**

```bash
git add server/src/api.ts
git commit -m "Add POST /api/agent SSE endpoint"
```

---

### Task 6: Frontend agent API client

**Files:**
- Create: `web/src/agentApi.ts`

**Interfaces:**
- Produces:
  - `type AgentEvent` (same shape as server)
  - `type ChatTurn = { role: "user" | "assistant"; content: string }`
  - `type AgentAppRef = { id: number; planning_reference: string; address_text: string | null; description: string | null; status: string; status_label: string; authority_id: string; lat: number | null; lng: number | null }`
  - `streamAgent(messages: ChatTurn[], onEvent: (ev: AgentEvent) => void, signal?: AbortSignal): Promise<void>`
  - `collectAppRefs(ev: AgentEvent, into: Map<number, AgentAppRef>): void` — harvests app summaries from `tool_result` events (`search_applications` results array, `geocode_location` ignored, `get_application_detail` single row)

- [ ] **Step 1: Implement `web/src/agentApi.ts`**

```ts
export type ChatTurn = { role: "user" | "assistant"; content: string };

export type AgentEvent =
  | { type: "text"; text: string }
  | { type: "tool_start"; name: string; input: Record<string, unknown> }
  | { type: "tool_result"; name: string; result: unknown }
  | { type: "error"; message: string }
  | { type: "done" };

export interface AgentAppRef {
  id: number;
  planning_reference: string;
  address_text: string | null;
  description: string | null;
  status: string;
  status_label: string;
  authority_id: string;
  lat: number | null;
  lng: number | null;
}

export async function streamAgent(
  messages: ChatTurn[],
  onEvent: (ev: AgentEvent) => void,
  signal?: AbortSignal
): Promise<void> {
  const res = await fetch("/api/agent", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ messages }),
    signal,
  });
  if (!res.ok || !res.body) throw new Error(`agent request failed (${res.status})`);
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf("\n\n")) >= 0) {
      const frame = buf.slice(0, i);
      buf = buf.slice(i + 2);
      const data = frame.split("\n").find((l) => l.startsWith("data: "));
      if (data) onEvent(JSON.parse(data.slice(6)) as AgentEvent);
    }
  }
}

function isAppRef(v: unknown): v is AgentAppRef {
  return typeof v === "object" && v !== null && "id" in v && "planning_reference" in v && "status" in v;
}

export function collectAppRefs(ev: AgentEvent, into: Map<number, AgentAppRef>): void {
  if (ev.type !== "tool_result") return;
  const r = ev.result as Record<string, unknown> | null;
  if (!r) return;
  if (ev.name === "search_applications" && Array.isArray(r.results)) {
    for (const row of r.results) if (isAppRef(row)) into.set(row.id, row);
  } else if (ev.name === "get_application_detail" && isAppRef(r)) {
    into.set(r.id, r);
  }
}
```

- [ ] **Step 2: Typecheck the web workspace**

Run: `cd web && npx tsc --noEmit`
Expected: no errors (if `web/node_modules` is missing locally, note it and rely on the Task 10 Vercel build)

- [ ] **Step 3: Commit**

```bash
git add web/src/agentApi.ts
git commit -m "Add agent SSE client and app-reference harvesting"
```

---

### Task 7: ChatPanel component

**Files:**
- Create: `web/src/components/ChatPanel.tsx`

**Interfaces:**
- Consumes: `streamAgent`, `collectAppRefs`, types from `../agentApi`; `StatusBadge` from `./ResultsList`
- Produces: `default ChatPanel({ onSelectApp, onAppsReferenced }: { onSelectApp: (id: number) => void; onAppsReferenced: (apps: AgentAppRef[]) => void })`

Design notes:
- Chat state lives inside ChatPanel (survives while App keeps it mounted; hide with CSS rather than unmounting to preserve the thread when switching tabs — App decides).
- Assistant message content is accumulated streamed text. Rendering splits on `[app:id:N]` tokens; each becomes a card (from the `appRefs` map); unknown ids render as plain text.
- While streaming, a status line shows the current tool activity.
- Text rendering: split double newlines into paragraphs, `**bold**` → `<strong>`, lines starting `- ` → list items. No markdown dependency (registry access is unreliable locally).

- [ ] **Step 1: Implement `web/src/components/ChatPanel.tsx`**

```tsx
import { useCallback, useRef, useState } from "react";
import {
  collectAppRefs,
  streamAgent,
  type AgentAppRef,
  type AgentEvent,
  type ChatTurn,
} from "../agentApi";
import { StatusBadge } from "./ResultsList";

interface Props {
  onSelectApp: (id: number) => void;
  onAppsReferenced: (apps: AgentAppRef[]) => void;
}

interface DisplayMessage {
  role: "user" | "assistant";
  content: string;
  error?: boolean;
}

const TOOL_LABELS: Record<string, string> = {
  search_applications: "Searching applications…",
  get_application_detail: "Reading an application…",
  get_conditions: "Checking decision conditions…",
  get_zoning: "Checking zoning…",
  get_flood_risk: "Checking flood risk…",
  get_appeal: "Reading the appeal case…",
  get_documents: "Listing documents…",
  geocode_location: "Locating the area…",
};

const TOKEN_RE = /\[app:id:(\d+)\]/g;

function AppRefCard({ app, onSelect }: { app: AgentAppRef; onSelect: (id: number) => void }) {
  return (
    <button type="button" className="result-card chat-app-card" onClick={() => onSelect(app.id)}>
      <div className="result-top">
        <strong>{app.address_text ?? app.planning_reference}</strong>
        <StatusBadge status={app.status} label={app.status_label} />
      </div>
      <p className="result-desc">{app.description}</p>
      <p className="result-meta">
        <span className="ref">{app.planning_reference}</span>
      </p>
    </button>
  );
}

function renderText(text: string, key: number) {
  // Minimal markdown: paragraphs, bullets, **bold**.
  const bold = (s: string) =>
    s.split(/\*\*([^*]+)\*\*/g).map((part, i) => (i % 2 ? <strong key={i}>{part}</strong> : part));
  return text
    .split(/\n{2,}/)
    .filter((p) => p.trim())
    .map((para, pi) => {
      const lines = para.split("\n");
      if (lines.every((l) => l.trim().startsWith("- "))) {
        return (
          <ul key={`${key}-${pi}`}>
            {lines.map((l, li) => (
              <li key={li}>{bold(l.trim().slice(2))}</li>
            ))}
          </ul>
        );
      }
      return <p key={`${key}-${pi}`}>{bold(para)}</p>;
    });
}

function AssistantMessage({
  content,
  appRefs,
  onSelectApp,
}: {
  content: string;
  appRefs: Map<number, AgentAppRef>;
  onSelectApp: (id: number) => void;
}) {
  const parts: Array<{ text?: string; appId?: number }> = [];
  let last = 0;
  for (const m of content.matchAll(TOKEN_RE)) {
    if (m.index! > last) parts.push({ text: content.slice(last, m.index) });
    parts.push({ appId: Number(m[1]) });
    last = m.index! + m[0].length;
  }
  if (last < content.length) parts.push({ text: content.slice(last) });

  return (
    <div className="chat-msg chat-assistant">
      {parts.map((p, i) => {
        if (p.appId != null) {
          const app = appRefs.get(p.appId);
          return app ? <AppRefCard key={i} app={app} onSelect={onSelectApp} /> : null;
        }
        return <div key={i}>{renderText(p.text ?? "", i)}</div>;
      })}
    </div>
  );
}

export default function ChatPanel({ onSelectApp, onAppsReferenced }: Props) {
  const [messages, setMessages] = useState<DisplayMessage[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const appRefs = useRef(new Map<number, AgentAppRef>());

  const send = useCallback(async () => {
    const q = input.trim();
    if (!q || busy) return;
    setInput("");
    setBusy(true);
    setStatus(null);
    const history: ChatTurn[] = [
      ...messages.filter((m) => !m.error).map((m) => ({ role: m.role, content: m.content })),
      { role: "user", content: q },
    ];
    setMessages((ms) => [...ms, { role: "user", content: q }, { role: "assistant", content: "" }]);

    const onEvent = (ev: AgentEvent) => {
      collectAppRefs(ev, appRefs.current);
      if (ev.type === "text") {
        setStatus(null);
        setMessages((ms) => {
          const out = [...ms];
          out[out.length - 1] = {
            ...out[out.length - 1],
            content: out[out.length - 1].content + ev.text,
          };
          return out;
        });
      } else if (ev.type === "tool_start") {
        setStatus(TOOL_LABELS[ev.name] ?? "Working…");
      } else if (ev.type === "tool_result") {
        const referenced = [...appRefs.current.values()];
        if (referenced.length) onAppsReferenced(referenced);
      } else if (ev.type === "error") {
        setMessages((ms) => [...ms.slice(0, -1), { role: "assistant", content: ev.message, error: true }]);
      }
    };

    try {
      await streamAgent(history, onEvent);
    } catch {
      setMessages((ms) => [
        ...ms.slice(0, -1),
        { role: "assistant", content: "Something went wrong — try again.", error: true },
      ]);
    } finally {
      setBusy(false);
      setStatus(null);
    }
  }, [input, busy, messages, onAppsReferenced]);

  return (
    <div className="chat-panel">
      <div className="chat-thread">
        {messages.length === 0 && (
          <div className="chat-empty">
            <p>Ask about planning in your area — for example:</p>
            <ul>
              <li>"What extensions have been approved near Griffith Avenue?"</li>
              <li>"Have any two-storey extensions been refused in Lucan, and why?"</li>
              <li>"What conditions do granted attic conversions in Maynooth usually carry?"</li>
            </ul>
          </div>
        )}
        {messages.map((m, i) =>
          m.role === "user" ? (
            <div key={i} className="chat-msg chat-user">
              <p>{m.content}</p>
            </div>
          ) : m.error ? (
            <div key={i} className="chat-msg chat-assistant chat-error">
              <p>{m.content}</p>
            </div>
          ) : (
            <AssistantMessage key={i} content={m.content} appRefs={appRefs.current} onSelectApp={onSelectApp} />
          )
        )}
        {status && (
          <p className="chat-status" role="status">
            {status}
          </p>
        )}
      </div>
      <form
        className="chat-input-row"
        onSubmit={(e) => {
          e.preventDefault();
          send();
        }}
      >
        <input
          type="text"
          value={input}
          placeholder="Ask about planning in your area…"
          onChange={(e) => setInput(e.target.value)}
          disabled={busy}
          aria-label="Ask the planning agent"
        />
        <button type="submit" disabled={busy || !input.trim()}>
          {busy ? "…" : "Ask"}
        </button>
      </form>
      <p className="chat-disclaimer">
        Shows what the planning register records — not advice or a prediction.
      </p>
    </div>
  );
}
```

- [ ] **Step 2: Typecheck**

Run: `cd web && npx tsc --noEmit`
Expected: no errors (or defer to Task 10 build if node_modules unavailable)

- [ ] **Step 3: Commit**

```bash
git add web/src/components/ChatPanel.tsx
git commit -m "Add agent chat panel with streamed text and application cards"
```

---

### Task 8: App integration and styles

**Files:**
- Modify: `web/src/App.tsx`
- Modify: `web/src/styles.css` (append)

**Interfaces:**
- Consumes: `ChatPanel` (Task 7), `AgentAppRef` from `../agentApi`, existing `select` callback + `mapData` state
- Produces: mode tabs ("Search" / "Ask"); in Ask mode the side panel shows ChatPanel (Search UI stays mounted but hidden so state survives); agent-referenced apps become map pins via `setMapData`

- [ ] **Step 1: Modify `web/src/App.tsx`**

Add imports:

```tsx
import ChatPanel from "./components/ChatPanel";
import type { AgentAppRef } from "./agentApi";
```

Add state after the existing `useState` block:

```tsx
const [mode, setMode] = useState<"search" | "ask">("search");
```

Add a callback after `nearMe`:

```tsx
const showAgentApps = useCallback((apps: AgentAppRef[]) => {
  const located = apps.filter((a) => a.lat != null && a.lng != null);
  if (!located.length) return;
  setMapData({
    type: "FeatureCollection",
    features: located.map((a) => ({
      type: "Feature",
      geometry: { type: "Point", coordinates: [a.lng as number, a.lat as number] },
      properties: {
        id: a.id,
        reference: a.planning_reference,
        status: a.status,
        authority_id: a.authority_id,
        address: a.address_text,
        is_domestic_guess: false,
      },
    })),
  });
  setFlyTo({ lat: located[0].lat as number, lng: located[0].lng as number });
}, []);
```

Replace the side-panel JSX (the `<div className="side-panel">…</div>` block) with:

```tsx
<div className="side-panel">
  <div className="mode-tabs" role="tablist" aria-label="Panel mode">
    <button
      type="button"
      role="tab"
      aria-selected={mode === "search"}
      className={mode === "search" ? "tab-active" : ""}
      onClick={() => setMode("search")}
    >
      Search
    </button>
    <button
      type="button"
      role="tab"
      aria-selected={mode === "ask"}
      className={mode === "ask" ? "tab-active" : ""}
      onClick={() => setMode("ask")}
    >
      Ask
    </button>
  </div>

  <div hidden={mode !== "search"}>
    <SearchBar
      value={state.q}
      onChange={(q) => setState((s) => ({ ...s, q }))}
      onSubmit={(q) => applyState({ ...state, q })}
      onNearMe={nearMe}
    />
    <FiltersBar meta={meta} state={state} onChange={applyState} />
    {error && (
      <p className="error" role="alert">
        {error}
      </p>
    )}
    <ResultsList
      results={results}
      total={total}
      fuzzy={fuzzy}
      loading={loading}
      selectedId={selectedId}
      onSelect={select}
      onHover={setHoveredId}
    />
  </div>

  <div hidden={mode !== "ask"} className="chat-wrap">
    <ChatPanel onSelectApp={select} onAppsReferenced={showAgentApps} />
  </div>
</div>
```

- [ ] **Step 2: Append chat styles to `web/src/styles.css`**

```css
/* ---- Agent chat ---- */
.mode-tabs {
  display: flex;
  gap: 4px;
  margin-bottom: 10px;
}
.mode-tabs button {
  flex: 1;
  padding: 8px 12px;
  border: 1px solid #d5d9e0;
  border-radius: 8px;
  background: #fff;
  font: inherit;
  cursor: pointer;
}
.mode-tabs .tab-active {
  background: #1a3c6e;
  border-color: #1a3c6e;
  color: #fff;
}
.chat-wrap {
  display: flex;
  flex-direction: column;
  min-height: 0;
  flex: 1;
}
.chat-panel {
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-height: 0;
  flex: 1;
}
.chat-thread {
  overflow-y: auto;
  flex: 1;
  min-height: 200px;
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 4px 2px;
}
.chat-msg {
  border-radius: 10px;
  padding: 8px 12px;
  max-width: 95%;
}
.chat-msg p {
  margin: 6px 0;
}
.chat-user {
  align-self: flex-end;
  background: #1a3c6e;
  color: #fff;
}
.chat-assistant {
  align-self: flex-start;
  background: #f1f3f7;
}
.chat-error {
  background: #fdecec;
  color: #8a1f1f;
}
.chat-status {
  font-style: italic;
  color: #667;
  margin: 0 4px;
}
.chat-app-card {
  margin: 6px 0;
  width: 100%;
  text-align: left;
}
.chat-empty {
  color: #556;
  font-size: 0.95em;
}
.chat-input-row {
  display: flex;
  gap: 6px;
}
.chat-input-row input {
  flex: 1;
  padding: 10px 12px;
  border: 1px solid #d5d9e0;
  border-radius: 8px;
  font: inherit;
}
.chat-input-row button {
  padding: 10px 16px;
  border: none;
  border-radius: 8px;
  background: #1a3c6e;
  color: #fff;
  font: inherit;
  cursor: pointer;
}
.chat-input-row button:disabled {
  opacity: 0.5;
  cursor: default;
}
.chat-disclaimer {
  font-size: 0.8em;
  color: #778;
  margin: 0;
}
```

Adjust colours to match the existing palette in `styles.css` (check the header/button colours already used and reuse those custom properties or hex values instead of `#1a3c6e` if the app uses different brand colours).

- [ ] **Step 3: Typecheck / build**

Run: `cd web && npx tsc --noEmit` (or `npm run build -w web` from root)
Expected: no errors

- [ ] **Step 4: Commit**

```bash
git add web/src/App.tsx web/src/styles.css
git commit -m "Add Ask tab: chat panel with agent-driven map pins"
```

---

### Task 9: Vercel serverless parity

**Files:**
- Modify: `api/index.mjs` (add agent section + route)
- Verify/Modify: `scripts/build-vercel.mjs` (response streaming flag)

**Interfaces:**
- Consumes (existing in `api/index.mjs`): `BUNDLE`, `runSearch(params: URLSearchParams)`, `publicApp(row)`, `ANTHROPIC_API_KEY`, plus its existing conditions/zoning/flood/appeal/document helpers (grep for the functions backing those routes and reuse them)
- Produces: `POST /api/agent` behaving identically to the Fastify route

Implementation notes for the executing engineer:

1. **Port, don't import.** `api/index.mjs` is dependency-free plain JS. Copy the logic of `tools.ts` (schemas + `bboxAround`), `prompt.ts` (SYSTEM_PROMPT — keep the two copies textually identical), and `agent.ts` (loop + SSE parse) into a clearly-marked `// ---- Planning agent ----` section.
2. **Tool executor adaptation.** The bundle version queries `BUNDLE.applications` instead of SQLite:
   - `search_applications`: build a `URLSearchParams` from the tool input (`q`, `status`, `domestic`, `appealed`, `receivedFrom/To`, `bbox` from `bboxAround`, `lat/lng` + `sort=distance`) and call the existing `runSearch(params)`; map rows through a trimmed version of `publicApp` limited to the `AgentAppSummary` fields.
   - Row lookup: `BUNDLE.applications.find((a) => a.id === id)`.
   - Conditions/zoning/flood/appeal/documents: call the same helper functions the existing `/api/applications/:id/...` routes in this file already use (locate them by reading those route bodies).
3. **Route registration.** In `handler`, before the 404 fallthrough, add:

```js
if (route === "/api/agent" && req.method === "POST") {
  const body = await readJsonBody(req); // add helper: collect req data events, JSON.parse, fallback {}
  const messages = (body?.messages ?? [])
    .filter((m) => (m.role === "user" || m.role === "assistant") && typeof m.content === "string" && m.content.trim())
    .slice(-30);
  if (!messages.length || messages[messages.length - 1].role !== "user") {
    return send(res, 400, { error: "messages must end with a user message" });
  }
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
  });
  try {
    for await (const ev of runAgentServerless(messages)) {
      res.write(`data: ${JSON.stringify(ev)}\n\n`);
    }
  } finally {
    res.end();
  }
  return;
}
```

4. **Streaming config.** Read `scripts/build-vercel.mjs`; the serverless function's `.vc-config.json` must include `"supportsResponseStreaming": true`. Add it if absent.
5. **Test.** Extend `server/test/serverless-loads.test.ts`-style coverage only if it can run without the bundle; otherwise verification is the Vercel deploy (Task 10).

- [ ] **Step 1: Add the agent section to `api/index.mjs`** (per notes above — port `SYSTEM_PROMPT`, `AGENT_TOOLS`, `bboxAround`, SSE parser, loop, bundle-backed executor, `readJsonBody`, route)
- [ ] **Step 2: Check/update `scripts/build-vercel.mjs` for `supportsResponseStreaming: true`**
- [ ] **Step 3: Syntax check**

Run: `node --check api/index.mjs && node --check scripts/build-vercel.mjs`
Expected: no output (both parse)

- [ ] **Step 4: Commit**

```bash
git add api/index.mjs scripts/build-vercel.mjs
git commit -m "Mirror the planning agent in the Vercel serverless handler"
```

---

### Task 10: Verification, backlog note, push

**Files:**
- Modify: `docs/BACKLOG.md`

- [ ] **Step 1: Add backlog entries**

Append to `docs/BACKLOG.md`:

```markdown
- **Agent: retention / change-of-use / non-building queries.** The planning
  agent v1 is tuned for domestic build questions (extensions, rebuilds, new
  dwellings). Retention permission, change of use, signage etc. need their
  own use-case research before tuning prompts/tools for them.

- **Agent: speed & cost optimisation.** v1 optimises for answer quality
  (Sonnet, unbounded tool loop up to 12 turns). Later: collapse common tool
  sequences into one pipeline call, cache geocode + conditions lookups, and
  consider embeddings for semantic comparable-matching.
```

- [ ] **Step 2: Full local test run**

Run: `cd server && npx vitest run`
Expected: all agent tests pass; only pre-existing failures (`search.test.ts`, `serverless-loads.test.ts`) remain

- [ ] **Step 3: Frontend build**

Run: `npm run build -w web` (from repo root)
Expected: Vite build succeeds. If npm/registry is unavailable locally, note it — the Vercel deploy is the fallback verification.

- [ ] **Step 4: Manual smoke test (if a local DB exists)**

Run: `npm run dev` from root; open http://localhost:5173, switch to the Ask tab, ask "What extensions have been granted near Maynooth?" — expect status lines, streamed text, cards, and map pins. Without a local DB, this moves to the deployed environment.

- [ ] **Step 5: Commit and push the branch**

```bash
git add docs/BACKLOG.md
git commit -m "Add agent follow-ups to backlog"
git push -u origin feature/planning-agent
```

Note: production deploys from `claude/ireland-planning-search-app-xtcqxf`, so pushing `feature/planning-agent` does not touch prod. If a preview deploy exists for the branch, verify the agent there (needs `ANTHROPIC_API_KEY` in the Vercel env — already set for summaries).

- [ ] **Step 6: Deployed verification**

On the branch preview URL: ask a question in the Ask tab, confirm streaming, cards, map pins, and that a vague question ("can I extend in Dublin?") triggers a clarifying question rather than a data dump.
