import type { AppSummary } from "./api";

async function j<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: init?.body ? { "Content-Type": "application/json" } : undefined,
  });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return res.json() as Promise<T>;
}

export interface SavedApp {
  id: number;
  authority_id: string;
  planning_reference: string;
  alerts_enabled: boolean;
  events_seen_at: string;
  created_at: string;
  has_update: boolean;
  /** Most recent recorded change on this application, if any. */
  latest_event_summary?: string | null;
  latest_event_at?: string | null;
  app: AppSummary | null;
}

export interface SavedList {
  id: number;
  name: string;
  position: number;
  alerts_enabled: boolean;
  item_ids: number[];
}

/**
 * What a watch alerts on. The ids match the strings already written into
 * area_watch_alerted — see api/_accounts/watches.mjs for why they cannot be
 * renamed.
 */
export type WatchKind = "application" | "decision" | "appeal" | "commencement";

export const WATCH_KIND_ORDER: WatchKind[] = [
  "application",
  "decision",
  "appeal",
  "commencement",
];

export const WATCH_KIND_LABELS: Record<WatchKind, { label: string; hint: string }> = {
  application: {
    label: "New applications",
    hint: "Someone applies for permission inside the area.",
  },
  decision: {
    label: "Decisions",
    hint: "The council grants or refuses. A refusal nearby is the precedent that matters most.",
  },
  appeal: {
    label: "Appeals",
    hint: "A decision inside the area is appealed to An Coimisiún Pleanála.",
  },
  commencement: {
    label: "Work starting on site",
    hint: "A commencement notice is filed — building is about to begin.",
  },
};

/** What a watch created before the choice existed was already alerting on. */
export const DEFAULT_WATCH_KINDS: WatchKind[] = ["application", "commencement"];

/** "250 m", "1 km" — the same wording wherever a radius is printed. */
export const fmtRadius = (m: number): string => (m < 1000 ? `${m} m` : `${m / 1000} km`);

/** Null on a watch saved before the choice existed, which means the default. */
export const watchKinds = (w: Pick<AreaWatch, "kinds">): WatchKind[] =>
  w.kinds?.length ? w.kinds : DEFAULT_WATCH_KINDS;

export interface AreaWatch {
  id: number;
  name: string;
  lat: number;
  lng: number;
  radius_m: number;
  kinds: WatchKind[] | null;
  alerts_enabled: boolean;
  created_at: string;
}

export interface Me {
  user: { email: string; name: string | null } | null;
  saves: SavedApp[];
  lists: SavedList[];
  watches?: AreaWatch[];
}

export const saveKey = (authorityId: string, reference: string) => `${authorityId}|${reference}`;

export const accountApi = {
  me: () => j<Me>("/api/me"),
  requestLink: (email: string) =>
    j<{ ok: boolean }>("/api/auth/request-link", { method: "POST", body: JSON.stringify({ email }) }),
  logout: () => j<{ ok: boolean }>("/api/auth/logout", { method: "POST", body: "{}" }),
  save: (authority_id: string, planning_reference: string) =>
    j<SavedApp>("/api/saves", { method: "POST", body: JSON.stringify({ authority_id, planning_reference }) }),
  unsave: (id: number) => j<{ ok: boolean }>(`/api/saves/${id}`, { method: "DELETE" }),
  /** The account's own details — a name, so far. */
  updateAccount: (patch: { name?: string | null }) =>
    j<{ user: { email: string; name: string | null } }>("/api/me", {
      method: "PATCH",
      body: JSON.stringify(patch),
    }),

  updateSave: (id: number, patch: { alerts_enabled?: boolean; seen?: boolean }) =>
    j<SavedApp>(`/api/saves/${id}`, { method: "PATCH", body: JSON.stringify(patch) }),
  createList: (name: string) =>
    j<SavedList>("/api/lists", { method: "POST", body: JSON.stringify({ name }) }),
  updateList: (id: number, patch: { name?: string; alerts_enabled?: boolean }) =>
    j<Pick<SavedList, "id" | "name" | "position"> | null>(`/api/lists/${id}`, { method: "PATCH", body: JSON.stringify(patch) }),
  deleteList: (id: number) => j<{ ok: boolean }>(`/api/lists/${id}`, { method: "DELETE" }),
  addToList: (listId: number, savedAppId: number) =>
    j<{ ok: boolean }>(`/api/lists/${listId}/items`, { method: "POST", body: JSON.stringify({ saved_app_id: savedAppId }) }),
  removeFromList: (listId: number, savedAppId: number) =>
    j<{ ok: boolean }>(`/api/lists/${listId}/items/${savedAppId}`, { method: "DELETE" }),
  createWatch: (watch: {
    name: string;
    lat: number;
    lng: number;
    radius_m: number;
    kinds: WatchKind[];
  }) => j<AreaWatch>("/api/watches", { method: "POST", body: JSON.stringify(watch) }),
  updateWatch: (id: number, patch: { alerts_enabled?: boolean; name?: string; kinds?: WatchKind[] }) =>
    j<AreaWatch | null>(`/api/watches/${id}`, { method: "PATCH", body: JSON.stringify(patch) }),
  deleteWatch: (id: number) => j<{ ok: boolean }>(`/api/watches/${id}`, { method: "DELETE" }),
};
