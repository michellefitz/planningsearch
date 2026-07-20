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
        <StatusBadge status={app.status} label={app.status_label ?? app.status} />
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
