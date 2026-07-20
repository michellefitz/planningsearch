# Planning Agent — Design Spec

**Date:** 2026-07-20
**Branch:** `feature/planning-agent`
**Status:** Approved for implementation

## Summary

A conversational AI agent that lets users ask natural language questions about planning applications and get rich, evidence-based responses. The primary use case is a homeowner exploring whether they're likely to encounter issues with a proposed development — extensions, rebuilds, new dwellings — by examining what happened with similar applications nearby.

The agent uses Claude Sonnet with tool-use to research the question across the existing planning data (search, conditions, appeals, zoning, documents), then synthesises the findings into a response that mixes streamed narrative text with rich UI elements (application cards, map pins, document links).

## Architecture: Tool-Use Agent

The agent is powered by Claude Sonnet calling a set of tools that wrap the existing backend endpoints. The model decides which tools to call based on the user's question, makes multiple calls as needed, then synthesises the results.

### Why tool-use over alternatives

- **Quality over speed:** The model decides the research strategy per question. It can ask clarifying questions, call tools in whatever order makes sense, and adapt based on intermediate results. This produces the best answers.
- **Extensible:** Adding new capabilities means adding a new tool, not redesigning a pipeline.
- **Future optimisation path:** Once the quality bar is established, frequently-used tool sequences can be collapsed into pre-computed pipelines (Approach B) or semantic search (Approach C) for speed/cost.

### Design principles

- **Present evidence, not predictions.** The agent shows what happened with similar applications — grant rates, conditions imposed, refusal reasons, appeal outcomes. It does not predict whether the user will get permission. This follows the PRD guardrail: "faithfulness to source beats cleverness."
- **Ask for specifics.** Vague locations produce vague answers. The agent should ask for a specific address or eircode when the location is too broad, explaining why (different zonings, different councils).
- **Surface meaningful conditions, not boilerplate.** Many grants carry generic conditions (construction hours, noise, site tidiness) that appear on every application. The agent should de-emphasise these and highlight substantive conditions — design modifications, size reductions, material changes, setback requirements — that actually affect what can be built.
- **Rich responses, not walls of text.** Responses include application cards (reusing the existing `ResultsList` card pattern), map pins for referenced applications, document links, and structured sections. The streamed text narrative gives immediate feedback; rich elements render once the data is resolved.

## Agent Tools

| Tool | Purpose | Backend source |
|------|---------|---------------|
| `search_applications` | Full-text search with filters: area/bbox, status, type, domestic flag, date range, keywords | `/api/search` |
| `get_application_detail` | Full detail for one application | `/api/applications/:id` |
| `get_conditions` | Conditions of grant or reasons for refusal | `/api/applications/:id/conditions` |
| `get_zoning` | Land-use zoning at a location (zone type, rules, guidelines) | `/api/applications/:id/zoning` |
| `get_flood_risk` | Flood risk at a location | `/api/applications/:id/flood` |
| `get_appeal` | Appeal case details from An Coimisiun Pleanala | `/api/applications/:id/appeal` |
| `get_documents` | Document listing for an application | `/api/applications/:id/files` |
| `geocode_location` | Resolve address/placename/eircode to coordinates + authority | New endpoint |
| `ask_user` | Ask the user a clarifying question | Frontend-only (no backend call) |

### Tool details

**`search_applications`** — wraps the existing FTS5 search with all current filters. The agent can search by keyword (e.g. "extension", "two storey"), filter by status (granted/refused), restrict to domestic, and scope to a geographic area via bounding box or radius from coordinates. Returns application summaries with coordinates for map plotting.

**`get_conditions`** — returns conditions of grant or reasons for refusal. The agent's system prompt instructs it to distinguish between boilerplate conditions (construction hours, noise, site maintenance — present on nearly every grant) and substantive conditions (design modifications, size reductions, material requirements, setback/boundary conditions). When synthesising, emphasise the substantive ones.

**`get_appeal`** — fetches appeal details including the appeal decision, whether it upheld/overturned the council, and the inspector's reasoning. Important for understanding what gets refused at council level but succeeds on appeal, and vice versa.

**`get_zoning`** — returns the zoning designation and any associated rules. The agent should reference relevant zoning context when it bears on the question (e.g. "this area is zoned New Residential — extensions are generally open for consideration" or "this is zoned Open Space/Agriculture — residential development would require a material change of use").

**`geocode_location`** — new endpoint. Takes a text string (address, placename, eircode) and returns lat/lng coordinates plus the relevant local authority. For v1, this can use the existing application data (find the closest known address) or a simple geocoding service. The agent uses this to scope searches geographically and to identify which council's area the user is asking about.

**`ask_user`** — not a backend call. When the agent calls this tool, the response is rendered as a message in the chat asking the user for more information. The conversation continues once they reply.

## Frontend

### Chat tab

A new tab alongside the existing search, labelled "Ask" or "Agent" (final name TBD during build). When active:

- The **left panel** (where the results list normally is) becomes a **chat thread**: user messages on the right, agent messages on the left.
- The **map** stays visible and updates to show pins for applications the agent references.
- The **detail panel** still works — clicking an application card in a chat response (or a map pin) opens it.

### Message types

Agent responses contain a mix of:

1. **Narrative text** — streamed progressively as the model generates. Markdown-formatted.
2. **Application cards** — compact cards showing address, status badge, description snippet, and reference. Rendered inline in the message. Clicking opens the existing detail panel. Uses the same visual pattern as `ResultsList` cards.
3. **Map updates** — applications referenced in the response appear as pins on the map. The map viewport adjusts to fit them.
4. **Document links** — inline links to specific documents when the agent references them.
5. **Status indicators** — while the agent is calling tools, show what it's doing ("Searching for extensions near Straffan Road...", "Checking conditions on 3 granted applications...").

### Multi-turn conversation

The chat is multi-turn. The full conversation history (user messages + assistant messages) is sent to the model on each turn. The user can ask follow-ups like:

- "What about the refused ones — why were they refused?"
- "Show me the ones that were appealed"
- "Are there any two-storey extensions specifically?"
- "What zoning is that area?"

The agent has the conversation context and can reference previous results or make new tool calls as needed.

## Backend

### New endpoint: `POST /api/agent`

Accepts a conversation (array of messages) and streams back the agent's response.

**Request:**
```json
{
  "messages": [
    { "role": "user", "content": "Can I build an extension near Straffan Road, Maynooth?" },
    { "role": "assistant", "content": "..." },
    { "role": "user", "content": "What about the refused ones?" }
  ]
}
```

**Response:** Server-sent events (SSE) stream with event types:
- `text` — a chunk of narrative text (streamed from the model)
- `tool_start` — the agent is calling a tool (name + params, for status indicators)
- `tool_result` — tool call completed (result data, for rendering cards/map)
- `done` — stream complete

The server handles the tool-use loop internally: it calls Claude Sonnet, executes any tool calls against the existing backend logic (in-process, not HTTP calls to itself), feeds results back to the model, and continues until the model produces a final response.

### System prompt

The agent's system prompt covers:
- What data is available and what the tools do
- Irish planning system basics (application types, decision flow, appeals process)
- The guardrail: present evidence, don't predict outcomes or give legal advice
- Condition classification: distinguish boilerplate from substantive conditions
- When to ask for clarification (vague locations, ambiguous development types)
- Response format guidance (use structured references to applications so the frontend can render cards)

### Structured references

When the agent references an application in its response, it uses a structured format that the frontend can parse and render as a card:

```
[app:id:1234]
```

The frontend replaces these tokens with rendered application cards. The application data comes from the tool results already in the response stream.

### Vercel serverless parity

Per the project's dual-backend pattern, the agent endpoint must also work in `api/index.mjs` for Vercel deployment. The tool implementations call the same logic functions that the Fastify routes use, so both entry points share the same agent behaviour.

## Example Flow

**User:** "I'm thinking about building a two-storey extension on my house near Celbridge Road in Maynooth. What have others done?"

**Agent thinks:** Location is somewhat specific but could benefit from more precision. Let me search first and see what comes up.

1. Calls `geocode_location("Celbridge Road, Maynooth")` → gets coords, confirms Kildare
2. Calls `search_applications({ near: coords, radius: 1000, keywords: "extension", domestic: true })` → finds 18 results
3. Calls `get_conditions` on 3-4 granted applications to see what conditions were imposed
4. Calls `get_conditions` on any refused applications to see refusal reasons
5. Calls `get_appeal` on any that were appealed

**Agent responds (streamed):**

> I found 18 domestic extension applications within 1km of Celbridge Road, Maynooth. Here's the picture:
>
> **15 were granted**, mostly single and two-storey rear/side extensions. Two-storey extensions specifically:
>
> [app:id:4521] [app:id:4892] [app:id:5103]
>
> Common substantive conditions on the grants included requirements to use matching external finishes, obscure glazing on upper-floor windows overlooking neighbours, and in two cases, a reduction in the proposed ridge height.
>
> **3 were refused.** The refusal reasons focused on:
> - Overlooking and loss of privacy to adjacent properties
> - The proposed bulk being out of character with the existing streetscape
>
> [app:id:4730] [app:id:5201]
>
> **1 refusal was appealed** and the appeal was granted with modified conditions — the inspector required the first-floor rear window to be fixed and obscure-glazed.
>
> [app:id:4730]
>
> The area is zoned **New Residential (C)** under the Kildare County Development Plan, where extensions are generally open for consideration subject to residential amenity.

## Future backlog items (not in v1)

- **Retention permission / change of use queries** — once use cases are better understood
- **Commercial use cases** — architect/builder workflows
- **Pre-computed embeddings (Approach C)** — for faster semantic matching once quality is proven
- **Pipeline optimisation (Approach B)** — collapse common tool sequences for speed/cost
- **Saved conversations** — let users bookmark or share agent conversations
- **Suggested questions** — prompt users with example questions when they first open the chat tab
