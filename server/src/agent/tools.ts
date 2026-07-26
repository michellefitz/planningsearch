import type { SearchFilters } from "../search.js";

export interface AnthropicTool {
  name: string;
  description: string;
  input_schema: { type: "object"; properties: Record<string, unknown>; required?: string[] };
}

const STATUSES = [
  "pending", "further_info", "granted", "refused",
  "withdrawn", "invalid", "incomplete", "appealed", "split", "decided",
];

export const AGENT_TOOLS: AnthropicTool[] = [
  {
    name: "count_applications",
    description:
      "Count and break down ALL applications matching the filters — the true size of the set, with no " +
      "result cap. Returns total plus breakdowns by status, type and year and counts of domestic, " +
      "granted, refused, appealed and commenced. Use this FIRST for any area/pattern question to " +
      "establish the denominator and compute rates over the whole set — never estimate rates from a " +
      "sample. Same filters as search_applications. Invalid/incomplete applications are excluded by " +
      "default (set include_invalid to count them).",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Keywords, e.g. 'two storey extension'" },
        statuses: { type: "array", items: { type: "string", enum: STATUSES } },
        domestic_only: { type: "boolean" },
        appealed_only: { type: "boolean" },
        commenced_only: { type: "boolean" },
        include_invalid: {
          type: "boolean",
          description: "Include invalid/incomplete applications (excluded by default as they are usually junk)",
        },
        near: {
          type: "object",
          properties: { lat: { type: "number" }, lng: { type: "number" } },
          required: ["lat", "lng"],
        },
        radius_km: { type: "number", description: "Search radius in km, used with near" },
        received_from: { type: "string", description: "ISO date lower bound on received date" },
        received_to: { type: "string", description: "ISO date upper bound on received date" },
      },
    },
  },
  {
    name: "search_applications",
    description:
      "Return a sample of individual applications (for citing specific examples). Full-text over address, " +
      "planning reference, applicant and description, with filters. Returns summaries including id, status, " +
      "decision, dates and coordinates. Capped at 50, so this is a SAMPLE — get the full-set stats from " +
      "count_applications, and use this for the specific examples you cite. Choose the sample basis with " +
      "sort (nearest / recent / relevance) and say which you used. Invalid/incomplete applications are " +
      "excluded by default.",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Keywords, e.g. 'two storey extension'" },
        statuses: { type: "array", items: { type: "string", enum: STATUSES } },
        domestic_only: { type: "boolean", description: "Restrict to likely-domestic applications" },
        appealed_only: { type: "boolean", description: "Only applications that went to appeal" },
        commenced_only: {
          type: "boolean",
          description:
            "Only permissions where a commencement notice was filed with building control — i.e. work actually started (or is about to)",
        },
        include_invalid: {
          type: "boolean",
          description: "Include invalid/incomplete applications (excluded by default as they are usually junk)",
        },
        sort: {
          type: "string",
          enum: ["nearest", "recent", "relevance"],
          description:
            "Sample basis: 'nearest' (needs near; the true closest N), 'recent' (most recently received), " +
            "or 'relevance' (best keyword match). Defaults to nearest when near is given, else recent.",
        },
        near: {
          type: "object",
          properties: { lat: { type: "number" }, lng: { type: "number" } },
          required: ["lat", "lng"],
        },
        radius_km: { type: "number", description: "Search radius in km, used with near" },
        received_from: { type: "string", description: "ISO date lower bound on received date" },
        received_to: { type: "string", description: "ISO date upper bound on received date" },
        limit: { type: "number", description: "Sample size, default 25, cap 50" },
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
    name: "read_appeal_document",
    description:
      "Fetch one document from an appeal case file on An Coimisiún Pleanála — the inspector's report, " +
      "Board order or Board direction — read it, and answer a question about what it says (or summarise " +
      "it). Use after get_appeal when the user asks what a case document actually says, e.g. what the " +
      "inspector recommended. Slow: fetches and reads a full PDF.",
    input_schema: {
      type: "object",
      properties: {
        application_id: { type: "number" },
        document: {
          type: "string",
          description:
            "Which document, as words from its title: e.g. 'inspector', 'board order', 'direction'. " +
            "Omit to read the main decision document.",
        },
        question: {
          type: "string",
          description: "What to find out from the document. Omit for a general summary.",
        },
      },
      required: ["application_id"],
    },
  },
  {
    name: "read_document",
    description:
      "Fetch one of the council's documents for an application (from the get_documents listing), read " +
      "it, and answer a question about what it says (or summarise it). Call get_documents first and " +
      "pass words from the chosen title. Works for PDFs only (most reports and orders are PDFs; " +
      "drawings often aren't). Slow: fetches and reads a full PDF.",
    input_schema: {
      type: "object",
      properties: {
        application_id: { type: "number" },
        title: { type: "string", description: "Words from the document title as listed by get_documents" },
        question: {
          type: "string",
          description: "What to find out from the document. Omit for a general summary.",
        },
      },
      required: ["application_id", "title"],
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

/** Invalid/incomplete applications are usually junk (abandoned part-submissions
 *  that get re-filed properly right after), so exclude them by default. */
const JUNK_STATUSES = ["invalid", "incomplete"];

export function searchFiltersFromToolInput(input: Record<string, unknown>): SearchFilters {
  const nearRaw = input.near as { lat?: unknown; lng?: unknown } | undefined;
  const lat = Number(nearRaw?.lat);
  const lng = Number(nearRaw?.lng);
  const near = Number.isFinite(lat) && Number.isFinite(lng) ? { lat, lng } : undefined;
  const radius = Number(input.radius_km);
  const statuses = Array.isArray(input.statuses) ? input.statuses.map(String) : undefined;
  // Only drop junk when the caller hasn't asked for a specific status set and
  // hasn't opted to include them.
  const excludeStatuses =
    !statuses && input.include_invalid !== true ? JUNK_STATUSES : undefined;

  let sort: SearchFilters["sort"];
  switch (input.sort) {
    case "recent":
      sort = "received";
      break;
    case "relevance":
      sort = "relevance";
      break;
    case "nearest":
      sort = "distance";
      break;
    default:
      sort = near ? "distance" : "relevance";
  }

  return {
    q: typeof input.query === "string" && input.query.trim() ? input.query : undefined,
    statuses,
    excludeStatuses,
    domesticOnly: input.domestic_only === true,
    appealedOnly: input.appealed_only === true,
    commencedOnly: input.commenced_only === true,
    receivedFrom: typeof input.received_from === "string" ? input.received_from : undefined,
    receivedTo: typeof input.received_to === "string" ? input.received_to : undefined,
    near,
    bbox: near && Number.isFinite(radius) && radius > 0 ? bboxAround(near.lat, near.lng, radius) : undefined,
    sort,
    limit: Math.min(Number(input.limit) || 25, 50),
  };
}
