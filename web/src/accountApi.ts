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
  app: AppSummary | null;
}

export interface SavedList {
  id: number;
  name: string;
  position: number;
  alerts_enabled: boolean;
  item_ids: number[];
}

export interface Me {
  user: { email: string } | null;
  saves: SavedApp[];
  lists: SavedList[];
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
  updateSave: (id: number, patch: { alerts_enabled?: boolean; seen?: boolean }) =>
    j<SavedApp>(`/api/saves/${id}`, { method: "PATCH", body: JSON.stringify(patch) }),
  createList: (name: string) =>
    j<SavedList>("/api/lists", { method: "POST", body: JSON.stringify({ name }) }),
  updateList: (id: number, patch: { name?: string; alerts_enabled?: boolean }) =>
    j<Omit<SavedList, "item_ids"> | null>(`/api/lists/${id}`, { method: "PATCH", body: JSON.stringify(patch) }),
  deleteList: (id: number) => j<{ ok: boolean }>(`/api/lists/${id}`, { method: "DELETE" }),
  addToList: (listId: number, savedAppId: number) =>
    j<{ ok: boolean }>(`/api/lists/${listId}/items`, { method: "POST", body: JSON.stringify({ saved_app_id: savedAppId }) }),
  removeFromList: (listId: number, savedAppId: number) =>
    j<{ ok: boolean }>(`/api/lists/${listId}/items/${savedAppId}`, { method: "DELETE" }),
};
