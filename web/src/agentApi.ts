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
