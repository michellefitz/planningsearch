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
