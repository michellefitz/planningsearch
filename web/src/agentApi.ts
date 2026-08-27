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
  received_date?: string | null;
  /** Sent by toolAppSummary all along; the card needs it to say when, not just what. */
  decision_date?: string | null;
  commencement_date?: string | null;
  completion_date?: string | null;
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
  if (!res.ok) {
    if (res.status === 429) {
      try {
        const body = await res.json();
        if (body.error === "daily_limit") {
          window.dispatchEvent(new CustomEvent("planview:daily-limit", { detail: body.message }));
          throw new Error(body.message ?? "You've reached your daily Ask limit. Try again tomorrow.");
        }
      } catch (e) {
        if (e instanceof Error && e.message !== `agent request failed (${res.status})`) throw e;
      }
    }
    throw new Error(`agent request failed (${res.status})`);
  }
  if (!res.body) throw new Error(`agent request failed (no body)`);
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
