/**
 * Ask chat history, stored on the device.
 *
 * The Ask panel unmounts the moment you leave it — click an application, open
 * Saved, follow a link — and React state goes with it, so a conversation you
 * had built up context in was simply gone when you came back (#94). This keeps
 * threads in localStorage: a small inbox of past chats you can reopen, and the
 * one you were last in restored on return.
 *
 * localStorage rather than sessionStorage on purpose — an inbox you go back to
 * should survive a reload and a browser restart, not just a tab switch. It is
 * per-device and not yet account-linked; syncing across devices via the
 * account is the follow-on noted in #94.
 */
import type { AgentAppRef } from "./agentApi";
import type { CountResult } from "./components/ChatStats";

export interface StoredMessage {
  role: "user" | "assistant";
  content: string;
  error?: boolean;
  stats?: CountResult[];
}

export interface ChatThread {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  messages: StoredMessage[];
  /** The app cards referenced anywhere in the thread — the prose carries
      [app:id] tokens, and the cards are rebuilt from these on reopen. */
  apps: AgentAppRef[];
}

const KEY = "planview.chat.threads.v1";
// The inbox is a recent-history list, not an archive — keep it short so it
// stays scannable and the store stays small.
const MAX_THREADS = 30;

export function newThreadId(): string {
  try {
    if (typeof crypto !== "undefined" && crypto.randomUUID) return crypto.randomUUID();
  } catch {
    /* fall through */
  }
  return `t_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

/** First user line, trimmed to a scannable label. */
export function deriveTitle(messages: StoredMessage[]): string {
  const first = messages.find((m) => m.role === "user" && m.content.trim());
  const text = first?.content.trim().replace(/\s+/g, " ") ?? "New chat";
  return text.length > 60 ? `${text.slice(0, 59).trimEnd()}…` : text;
}

/** All threads, most-recently-updated first. Never throws. */
export function loadThreads(): ChatThread[] {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return (parsed as ChatThread[])
      .filter((t) => t && typeof t.id === "string" && Array.isArray(t.messages))
      .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
  } catch {
    return [];
  }
}

function write(threads: ChatThread[]): ChatThread[] {
  const capped = threads
    .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
    .slice(0, MAX_THREADS);
  try {
    localStorage.setItem(KEY, JSON.stringify(capped));
  } catch {
    /* private mode, quota, disabled storage — history is a convenience, so
       losing the write is acceptable; the live conversation is unaffected. */
  }
  return capped;
}

/**
 * Insert or update one thread, returning the refreshed, ordered list. Empty
 * threads (no messages) are never stored, so navigating in and straight back
 * out does not litter the inbox with blanks.
 */
export function saveThread(thread: ChatThread): ChatThread[] {
  const existing = loadThreads();
  if (thread.messages.length === 0) return existing;
  const others = existing.filter((t) => t.id !== thread.id);
  return write([...others, thread]);
}

export function deleteThread(id: string): ChatThread[] {
  return write(loadThreads().filter((t) => t.id !== id));
}

/** "just now", "3 min ago", "2 days ago" — the age of a thread in the inbox. */
export function relativeTime(ts: number): string {
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 45) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} hr${h === 1 ? "" : "s"} ago`;
  const d = Math.round(h / 24);
  if (d < 7) return `${d} day${d === 1 ? "" : "s"} ago`;
  return new Date(ts).toLocaleDateString("en-IE", { day: "numeric", month: "short" });
}
