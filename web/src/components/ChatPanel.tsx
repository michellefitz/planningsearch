import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
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

// Chat cards carry only the agent's slim app summary, which has no display
// name for the council — five tenants, so a local map beats a meta fetch.
const AUTHORITY_SHORT_NAMES: Record<string, string> = {
  "dublin-city": "Dublin City",
  fingal: "Fingal",
  dlr: "Dún Laoghaire-Rathdown",
  "south-dublin": "South Dublin",
  kildare: "Kildare",
};

const TOOL_LABELS: Record<string, string> = {
  search_applications: "Searching applications…",
  get_application_detail: "Reading an application…",
  get_conditions: "Checking decision conditions…",
  get_zoning: "Checking zoning…",
  get_appeal: "Reading the appeal case…",
  get_documents: "Listing documents…",
  read_appeal_document: "Reading a case document — this can take a minute…",
  read_document: "Reading a council document — this can take a minute…",
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
        {AUTHORITY_SHORT_NAMES[app.authority_id] && ` · ${AUTHORITY_SHORT_NAMES[app.authority_id]}`}
        {app.received_date && ` · received ${app.received_date}`}
        {app.commencement_date && (
          <span
            className="tag tag-commenced"
            title="A commencement notice was filed with building control for this permission"
          >
            {app.completion_date ? "built" : "work commenced"}
          </span>
        )}
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
  seenCards,
  onSelectApp,
  onHoverApp,
}: {
  content: string;
  appRefs: Map<number, AgentAppRef>;
  seenCards: Set<number>;
  onSelectApp: (id: number) => void;
  onHoverApp: (id: number | null) => void;
}) {
  // Cards are pulled out of the prose and rendered after the paragraph they
  // appear in — never mid-sentence — and only the first time a property comes
  // up in the whole conversation. `seenCards` is threaded across messages so a
  // property mentioned again later doesn't render its card a second time.
  const blocks: ReactNode[] = [];
  content.split(/\n{2,}/).forEach((para, pi) => {
    const ids: number[] = [];
    for (const m of para.matchAll(TOKEN_RE)) ids.push(Number(m[1]));
    // Strip the tokens from the prose and tidy the whitespace/punctuation they
    // leave behind so a mid-sentence reference reads cleanly.
    const prose = para
      .replace(TOKEN_RE, "")
      .replace(/[ \t]{2,}/g, " ")
      .replace(/[ \t]+([.,;:!?])/g, "$1")
      .trim();
    if (prose) blocks.push(<div key={`t${pi}`}>{renderText(prose, pi)}</div>);
    for (const id of ids) {
      if (seenCards.has(id)) continue;
      seenCards.add(id);
      const app = appRefs.get(id);
      if (app)
        blocks.push(
          <AppRefCard key={`c${pi}-${id}`} app={app} onSelect={onSelectApp} onHover={onHoverApp} />
        );
    }
  });

  return <div className="chat-msg chat-assistant">{blocks}</div>;
}

export default function ChatPanel({ onSelectApp, onHoverApp, onAppsReferenced }: Props) {
  const [messages, setMessages] = useState<DisplayMessage[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const appRefs = useRef(new Map<number, AgentAppRef>());

  const threadRef = useRef<HTMLDivElement>(null);
  // Pinned to the bottom? Set false the moment the user scrolls up, so the
  // thread never yanks them back mid-read; re-arms when they return.
  const stickRef = useRef(true);
  // Streamed text arrives in uneven network chunks; the reveal loop drains it
  // at a steady per-frame rate instead, so the reply reads as typing.
  const targetRef = useRef("");
  const shownRef = useRef(0);
  const replyIndexRef = useRef<number | null>(null);
  const rafRef = useRef<number>();

  const scrollToBottom = useCallback((smooth = false) => {
    const el = threadRef.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: smooth ? "smooth" : "auto" });
  }, []);

  const onThreadScroll = useCallback(() => {
    const el = threadRef.current;
    if (el) stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
  }, []);

  const setReplyContent = useCallback((content: string, error = false) => {
    const idx = replyIndexRef.current;
    if (idx == null) return;
    setMessages((ms) =>
      idx < ms.length ? ms.map((m, i) => (i === idx ? { ...m, content, ...(error ? { error } : {}) } : m)) : ms
    );
  }, []);

  const stopReveal = useCallback(() => {
    if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
    rafRef.current = undefined;
  }, []);

  const revealTick = useCallback(() => {
    rafRef.current = undefined;
    const target = targetRef.current;
    if (shownRef.current < target.length) {
      // Steady drip that speeds up with the backlog, so it never falls
      // hopelessly behind a fast stream but never dumps a whole chunk.
      const backlog = target.length - shownRef.current;
      shownRef.current = Math.min(target.length, shownRef.current + Math.max(2, Math.ceil(backlog / 24)));
      setReplyContent(target.slice(0, shownRef.current));
      if (stickRef.current) scrollToBottom();
    }
    if (shownRef.current < targetRef.current.length) rafRef.current = requestAnimationFrame(revealTick);
  }, [scrollToBottom, setReplyContent]);

  const ensureReveal = useCallback(() => {
    if (rafRef.current == null) rafRef.current = requestAnimationFrame(revealTick);
  }, [revealTick]);

  useEffect(() => stopReveal, [stopReveal]);

  // Status lines and app cards appear outside the reveal loop — keep the
  // bottom in view for those too, but only while pinned.
  useEffect(() => {
    if (stickRef.current) scrollToBottom();
  }, [status, messages.length, scrollToBottom]);

  const send = useCallback(async () => {
    const q = input.trim();
    if (!q || busy) return;
    setInput("");
    setBusy(true);
    setStatus(null);
    // A previous reply may still be drip-revealing — complete it instantly.
    stopReveal();
    if (shownRef.current < targetRef.current.length) setReplyContent(targetRef.current);
    const history: ChatTurn[] = [
      ...messages.filter((m) => !m.error).map((m) => ({ role: m.role, content: m.content })),
      { role: "user", content: q },
    ];
    targetRef.current = "";
    shownRef.current = 0;
    replyIndexRef.current = messages.length + 1;
    setMessages((ms) => [...ms, { role: "user", content: q }, { role: "assistant", content: "" }]);
    // Sending re-arms the pin and rides down to the new question.
    stickRef.current = true;
    requestAnimationFrame(() => scrollToBottom(true));

    const onEvent = (ev: AgentEvent) => {
      collectAppRefs(ev, appRefs.current);
      if (ev.type === "text") {
        setStatus(null);
        targetRef.current += ev.text;
        ensureReveal();
      } else if (ev.type === "tool_start") {
        setStatus(TOOL_LABELS[ev.name] ?? "Working…");
      } else if (ev.type === "tool_result") {
        const referenced = [...appRefs.current.values()];
        if (referenced.length) onAppsReferenced(referenced);
      } else if (ev.type === "error") {
        stopReveal();
        targetRef.current = ev.message;
        shownRef.current = ev.message.length;
        setReplyContent(ev.message, true);
      }
    };

    try {
      await streamAgent(history, onEvent);
    } catch {
      stopReveal();
      targetRef.current = "";
      shownRef.current = 0;
      setReplyContent("Something went wrong — try again.", true);
    } finally {
      setBusy(false);
      setStatus(null);
    }
  }, [input, busy, messages, onAppsReferenced, ensureReveal, scrollToBottom, setReplyContent, stopReveal]);

  return (
    <div className="chat-panel">
      <div className="chat-thread" ref={threadRef} onScroll={onThreadScroll}>
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
        {(() => {
          // One card per property for the whole conversation. Built fresh each
          // render and mutated as messages render top-to-bottom, so an earlier
          // message keeps the card and later mentions don't repeat it.
          const seenCards = new Set<number>();
          return messages.map((m, i) =>
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
                seenCards={seenCards}
                onSelectApp={onSelectApp}
                onHoverApp={onHoverApp}
              />
            )
          );
        })()}
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
