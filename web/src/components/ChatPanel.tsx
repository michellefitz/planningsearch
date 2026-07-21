import { useCallback, useRef, useState, type ReactNode } from "react";
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
  onHoverApp: (id: number | null) => void;
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

// Canonical form is [app:id:35269], but the model sometimes emits
// [app:35269] or [app:35269:35269] — accept all three.
const TOKEN_RE = /\[app:(?:id:)?(\d+)(?::\d+)?\]/g;

function AppRefCard({
  app,
  onSelect,
  onHover,
}: {
  app: AgentAppRef;
  onSelect: (id: number) => void;
  onHover: (id: number | null) => void;
}) {
  return (
    <button
      type="button"
      className="result-card chat-app-card"
      onClick={() => onSelect(app.id)}
      onMouseEnter={() => onHover(app.id)}
      onMouseLeave={() => onHover(null)}
      onFocus={() => onHover(app.id)}
      onBlur={() => onHover(null)}
    >
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

// Minimal markdown renderer: headings, bullet/numbered lists, **bold**,
// *italic*/_italic_, links flattened to their label. Unpaired markers stay literal.
const ITALIC_RE = /(\*[^*\s][^*\n]*\*|_[^_\s][^_\n]*_)/g;
const BULLET_RE = /^[-*]\s+/;
const ORDERED_RE = /^\d+[.)]\s+/;

function inline(s: string): ReactNode[] {
  const text = s.replace(/\[([^\]]*)\]\([^)\s]*\)/g, "$1");
  return text.split(/\*\*([^*]+)\*\*/g).flatMap((part, i) => {
    if (i % 2) return [<strong key={`b${i}`}>{part}</strong>];
    return part
      .split(ITALIC_RE)
      .map((seg, j) =>
        j % 2 ? <em key={`i${i}-${j}`}>{seg.slice(1, -1)}</em> : seg
      );
  });
}

function renderText(text: string, key: number) {
  const blocks: ReactNode[] = [];
  text
    .split(/\n{2,}/)
    .filter((p) => p.trim())
    .forEach((para, pi) => {
      const lines = para
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean);
      let i = 0;
      let seg = 0;
      while (i < lines.length) {
        const k = `${key}-${pi}-${seg++}`;
        const heading = lines[i].match(/^#{1,4}\s+(.*)/);
        if (heading) {
          blocks.push(
            <p key={k} className="chat-heading">
              {inline(heading[1])}
            </p>
          );
          i++;
        } else if (BULLET_RE.test(lines[i])) {
          const items: string[] = [];
          while (i < lines.length && BULLET_RE.test(lines[i]))
            items.push(lines[i++].replace(BULLET_RE, ""));
          blocks.push(
            <ul key={k}>
              {items.map((it, li) => (
                <li key={li}>{inline(it)}</li>
              ))}
            </ul>
          );
        } else if (ORDERED_RE.test(lines[i])) {
          const items: string[] = [];
          while (i < lines.length && ORDERED_RE.test(lines[i]))
            items.push(lines[i++].replace(ORDERED_RE, ""));
          blocks.push(
            <ol key={k}>
              {items.map((it, li) => (
                <li key={li}>{inline(it)}</li>
              ))}
            </ol>
          );
        } else {
          const plain: string[] = [];
          while (
            i < lines.length &&
            !/^#{1,4}\s/.test(lines[i]) &&
            !BULLET_RE.test(lines[i]) &&
            !ORDERED_RE.test(lines[i])
          )
            plain.push(lines[i++]);
          blocks.push(<p key={k}>{inline(plain.join("\n"))}</p>);
        }
      }
    });
  return blocks;
}

function AssistantMessage({
  content,
  appRefs,
  onSelectApp,
  onHoverApp,
}: {
  content: string;
  appRefs: Map<number, AgentAppRef>;
  onSelectApp: (id: number) => void;
  onHoverApp: (id: number | null) => void;
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
          return app ? <AppRefCard key={i} app={app} onSelect={onSelectApp} onHover={onHoverApp} /> : null;
        }
        return <div key={i}>{renderText(p.text ?? "", i)}</div>;
      })}
    </div>
  );
}

export default function ChatPanel({ onSelectApp, onHoverApp, onAppsReferenced }: Props) {
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
            <AssistantMessage
              key={i}
              content={m.content}
              appRefs={appRefs.current}
              onSelectApp={onSelectApp}
              onHoverApp={onHoverApp}
            />
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
