import { lazy, Suspense, useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import {
  collectAppRefs,
  streamAgent,
  type AgentAppRef,
  type AgentEvent,
  type ChatTurn,
} from "../agentApi";
import { renderMarkdown as renderText } from "../markdown";
import { StatusBadge } from "./ResultsList";
import ChatStats, { type CountResult } from "./ChatStats";
import { ChevronRightIcon } from "./icons";
import { posthog } from "../posthog";
import { Waiting } from "../loading";

const ChatMap = lazy(() => import("./ChatMap"));

interface Props {
  onSelectApp: (id: number) => void;
  onHoverApp: (id: number | null) => void;
  onAppsReferenced: (apps: AgentAppRef[]) => void;
}

interface DisplayMessage {
  role: "user" | "assistant";
  content: string;
  error?: boolean;
  stats?: CountResult[];
}

// Chat cards carry only the agent's slim app summary, which has no display
// name for the council — five tenants, so a local map beats a meta fetch.
const AUTHORITY_SHORT_NAMES: Record<string, string> = {
  "dublin-city": "Dublin City",
  fingal: "Fingal",
  dlr: "Dún Laoghaire-Rathdown",
  "south-dublin": "South Dublin",
  kildare: "Kildare",
  meath: "Meath",
  wicklow: "Wicklow",
  "cork-city": "Cork City",
  "cork-county": "Cork County",
  wexford: "Wexford",
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
const EXAMPLES = [
  "What extensions have been approved near Griffith Avenue?",
  "Have any two-storey extensions been refused in Lucan, and why?",
  "What conditions do granted attic conversions in Maynooth usually carry?",
];

const TOKEN_RE = /\[app:(?:id:)?(\d+)(?::\d+)?\]/g;

/** "Aug 2024" — a month is as precise as this line needs to be. */
export function monthYear(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? iso
    : d.toLocaleDateString("en-IE", { month: "short", year: "numeric" });
}

/**
 * The quiet line under the reference: which property, whose register, when.
 *
 * The address is here rather than as a heading because the paragraph above has
 * already named it — but it has to be *somewhere*, since an answer often cites
 * several properties and a bare reference gives a reader nothing to match
 * against the prose.
 *
 * Decided beats received: it is when the outcome on the badge happened. Both
 * are labelled, because an unlabelled date beside "Pending decision" reads
 * either way.
 *
 * Returned in two parts rather than one string so the layout can decide what
 * gives when there is not enough room. On a phone the joined line lost the
 * council and the date first — the two things the card exists to carry — so
 * only the address truncates now.
 */
export function cardParts(app: {
  address_text?: string | null;
  authority_id: string;
  decision_date?: string | null;
  received_date?: string | null;
}): { where: string | null; when: string | null } {
  const date = app.decision_date
    ? `decided ${monthYear(app.decision_date)}`
    : app.received_date
      ? `received ${monthYear(app.received_date)}`
      : null;
  return {
    where: app.address_text?.trim() || null,
    when: [AUTHORITY_SHORT_NAMES[app.authority_id], date].filter(Boolean).join(" · ") || null,
  };
}

/** The same line as one string — for the hover title, where the address is
 *  whole even when the rendered one has been truncated. */
export function cardMeta(app: Parameters<typeof cardParts>[0]): string {
  const { where, when } = cardParts(app);
  return [where, when].filter(Boolean).join(" · ");
}

/**
 * One cited application, under the paragraph that discusses it.
 *
 * A citation, not a second telling of it. This used to be the search-results
 * row — address as a heading, the council's full description, then the meta
 * line — which restated three things the sentence above had just said, and,
 * being `.result-card`, carried no border or fill because in the results list
 * the dividers do that work. In a chat bubble there are no dividers, so it
 * read as another paragraph.
 *
 * What survives is what the prose cannot give you: the reference, the council,
 * the date, and a way in. The address stays too, quietly, on the same line —
 * an answer often cites several properties, and without a name there is no way
 * to tell which paragraph a card belongs to.
 */
function AppRefCard({
  app,
  onSelect,
  onHover,
}: {
  app: AgentAppRef;
  onSelect: (id: number) => void;
  onHover: (id: number | null) => void;
}) {
  const { where, when } = cardParts(app);

  return (
    <button
      type="button"
      className="chat-app-card"
      onClick={() => onSelect(app.id)}
      onMouseEnter={() => onHover(app.id)}
      onMouseLeave={() => onHover(null)}
      onFocus={() => onHover(app.id)}
      onBlur={() => onHover(null)}
    >
      <span className="chat-card-lines">
        <span className="chat-card-head">
          <span className="ref">{app.planning_reference}</span>
          <StatusBadge status={app.status} label={app.status_label ?? app.status} />
          {app.commencement_date && (
            <span
              className="tag tag-commenced"
              title="A commencement notice was filed with building control for this permission"
            >
              {app.completion_date ? "built" : "work commenced"}
            </span>
          )}
        </span>
        {(where || when) && (
          <span className="chat-card-meta" title={cardMeta(app)}>
            {where && <span className="chat-card-where">{where}</span>}
            {when && <span className="chat-card-when">{when}</span>}
          </span>
        )}
      </span>
      <span className="chat-card-open">
        Open
        <ChevronRightIcon />
      </span>
    </button>
  );
}

function AssistantMessage({
  content,
  appRefs,
  seenCards,
  stats,
  onSelectApp,
  onHoverApp,
}: {
  content: string;
  appRefs: Map<number, AgentAppRef>;
  seenCards: Set<number>;
  stats?: CountResult[];
  onSelectApp: (id: number) => void;
  onHoverApp: (id: number | null) => void;
}) {
  const blocks: ReactNode[] = [];
  const messageAppIds: number[] = [];

  content.split(/\n{2,}/).forEach((para, pi) => {
    const ids: number[] = [];
    for (const m of para.matchAll(TOKEN_RE)) ids.push(Number(m[1]));
    const prose = para
      .replace(TOKEN_RE, "")
      .replace(/[ \t]{2,}/g, " ")
      .replace(/[ \t]+([.,;:!?])/g, "$1")
      .trim();
    if (prose) blocks.push(<div key={`t${pi}`}>{renderText(prose, pi)}</div>);
    for (const id of ids) {
      messageAppIds.push(id);
      if (seenCards.has(id)) continue;
      seenCards.add(id);
      const app = appRefs.get(id);
      if (app)
        blocks.push(
          <AppRefCard key={`c${pi}-${id}`} app={app} onSelect={onSelectApp} onHover={onHoverApp} />
        );
    }
  });

  if (stats?.length) {
    for (let si = 0; si < stats.length; si++) {
      blocks.push(<ChatStats key={`s${si}`} data={stats[si]} />);
    }
  }

  const mapApps = messageAppIds
    .map((id) => appRefs.get(id))
    .filter((a): a is AgentAppRef => a != null && a.lat != null && a.lng != null);
  const uniqueMap = [...new Map(mapApps.map((a) => [a.id, a])).values()];

  if (uniqueMap.length >= 2) {
    blocks.push(
      <Suspense key="map" fallback={null}>
        <ChatMap apps={uniqueMap} onSelect={onSelectApp} />
      </Suspense>
    );
  }

  return <div className="chat-msg chat-assistant">{blocks}</div>;
}

export default function ChatPanel({ onSelectApp, onHoverApp, onAppsReferenced }: Props) {
  const [messages, setMessages] = useState<DisplayMessage[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  /* Once words are arriving the reply is its own progress report; until then
     something has to speak for it. The gap this closes is the first one: the
     model can spend the better part of a minute deciding what to look up
     before it emits a single tool call, and that whole time the panel showed
     an ellipsis on a disabled button and nothing else. */
  const [answering, setAnswering] = useState(false);
  const appRefs = useRef(new Map<number, AgentAppRef>());
  const pendingStats = useRef<CountResult[]>([]);

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

  const send = useCallback(async (prefill?: string) => {
    const q = (prefill ?? input).trim();
    if (!q || busy) return;
    setInput("");
    posthog.capture("chat_question_submitted", { question_length: q.length });
    setBusy(true);
    setStatus(null);
    setAnswering(false);
    // A previous reply may still be drip-revealing — complete it instantly.
    stopReveal();
    if (shownRef.current < targetRef.current.length) setReplyContent(targetRef.current);
    const history: ChatTurn[] = [
      ...messages.filter((m) => !m.error).map((m) => ({ role: m.role, content: m.content })),
      { role: "user", content: q },
    ];
    targetRef.current = "";
    shownRef.current = 0;
    pendingStats.current = [];
    replyIndexRef.current = messages.length + 1;
    setMessages((ms) => [...ms, { role: "user", content: q }, { role: "assistant", content: "" }]);
    // Sending re-arms the pin and rides down to the new question.
    stickRef.current = true;
    requestAnimationFrame(() => scrollToBottom(true));

    const onEvent = (ev: AgentEvent) => {
      collectAppRefs(ev, appRefs.current);
      if (ev.type === "text") {
        setStatus(null);
        setAnswering(true);
        targetRef.current += ev.text;
        ensureReveal();
      } else if (ev.type === "tool_start") {
        setStatus(TOOL_LABELS[ev.name] ?? "Working…");
      } else if (ev.type === "tool_result") {
        if (ev.name === "count_applications" && ev.result && typeof ev.result === "object") {
          const r = ev.result as Record<string, unknown>;
          if (typeof r.total === "number" && r.total > 0) {
            pendingStats.current.push(r as unknown as CountResult);
          }
        }
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
      if (pendingStats.current.length > 0) {
        const stats = [...pendingStats.current];
        const idx = replyIndexRef.current;
        if (idx != null) {
          setMessages((ms) => ms.map((m, i) => (i === idx ? { ...m, stats } : m)));
        }
      }
    }
  }, [input, busy, messages, onAppsReferenced, ensureReveal, scrollToBottom, setReplyContent, stopReveal]);

  return (
    <div className="chat-panel">
      <div className="chat-thread" ref={threadRef} onScroll={onThreadScroll}>
        {messages.length === 0 && (
          <div className="chat-empty">
            <p>Ask about planning in your area.</p>
            <p className="chat-beta">Early beta — answers are generated from planning register data and may contain errors.</p>
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
                stats={m.stats}
                onSelectApp={onSelectApp}
                onHoverApp={onHoverApp}
              />
            )
          );
        })()}
        {/* Keyed on the status so each new step restarts its own clock:
            "Reading a council document" genuinely takes a minute, and the
            escalation has to be about that step rather than about the whole
            answer. */}
        {busy && (status !== null || !answering) && (
          <Waiting
            key={status ?? "thinking"}
            active
            className="chat-status"
            stages={
              status
                ? [
                    [0, status],
                    [20, `${status.replace(/[….]+$/, "")} — still going.`],
                  ]
                : [
                    [0, "Thinking…"],
                    [8, "Still thinking — working out what to look up."],
                    [25, "Still going. This one is taking a while."],
                  ]
            }
          />
        )}
      </div>
      {messages.length === 0 && !busy && (
        <div className="chat-suggestions">
          {EXAMPLES.map((ex) => (
            <button key={ex} type="button" className="chat-suggestion" onClick={() => send(ex)}>
              {ex}
            </button>
          ))}
        </div>
      )}
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
