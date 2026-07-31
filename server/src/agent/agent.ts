import { AGENT_TOOLS } from "./tools.js";
import { SYSTEM_PROMPT } from "./prompt.js";

const MODEL = "claude-sonnet-5";
const MAX_TURNS = 12;
const MAX_TOKENS = 4000;
const TOOL_RESULT_CHAR_CAP = 30_000;

export type ChatTurn = { role: "user" | "assistant"; content: string };

export type AgentEvent =
  | { type: "text"; text: string }
  | { type: "tool_start"; name: string; input: unknown }
  | { type: "tool_result"; name: string; result: unknown }
  | { type: "error"; message: string }
  | { type: "done" };

type ContentBlock =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> };

interface StreamEvent {
  type: string;
  index?: number;
  content_block?: { type: string; id?: string; name?: string; text?: string };
  delta?: { type?: string; text?: string; partial_json?: string; stop_reason?: string };
}

async function* parseSse(body: ReadableStream<Uint8Array>): AsyncGenerator<StreamEvent> {
  const decoder = new TextDecoder();
  let buf = "";
  for await (const chunk of body as unknown as AsyncIterable<Uint8Array>) {
    buf += decoder.decode(chunk, { stream: true });
    let i;
    while ((i = buf.indexOf("\n\n")) >= 0) {
      const frame = buf.slice(0, i);
      buf = buf.slice(i + 2);
      const data = frame.split("\n").find((l) => l.startsWith("data: "));
      if (data) {
        try {
          yield JSON.parse(data.slice(6)) as StreamEvent;
        } catch {
          // skip malformed frames
        }
      }
    }
  }
}

export interface RunAgentOptions {
  messages: ChatTurn[];
  executeTool: (name: string, input: Record<string, unknown>) => Promise<unknown>;
  fetchImpl?: typeof fetch;
  apiKey?: string;
  model?: string;
  /** Per-council register depth, appended to the system prompt so the model can
   *  tell "we don't hold that year" from "it doesn't exist". */
  coverageClause?: string;
}

export async function* runAgent(opts: RunAgentOptions): AsyncGenerator<AgentEvent> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const apiKey = opts.apiKey ?? process.env.ANTHROPIC_API_KEY ?? "";
  if (!apiKey) {
    yield { type: "error", message: "The agent is not configured on this deployment (missing API key)." };
    yield { type: "done" };
    return;
  }

  // Anthropic-format message list; grows with tool_use / tool_result turns.
  const msgs: Array<{ role: "user" | "assistant"; content: unknown }> = opts.messages.map((m) => ({
    role: m.role,
    content: m.content,
  }));

  for (let turn = 0; turn < MAX_TURNS; turn++) {
    let res: Response;
    try {
      res = await fetchImpl("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: opts.model ?? MODEL,
          max_tokens: MAX_TOKENS,
          stream: true,
          system: SYSTEM_PROMPT + (opts.coverageClause ?? ""),
          tools: AGENT_TOOLS,
          messages: msgs,
        }),
      });
    } catch {
      yield { type: "error", message: "Could not reach the AI service." };
      yield { type: "done" };
      return;
    }
    if (!res.ok || !res.body) {
      yield { type: "error", message: `AI service error (${res.status}).` };
      yield { type: "done" };
      return;
    }

    const blocks: ContentBlock[] = [];
    const partialJson: Record<number, string> = {};
    let stopReason: string | null = null;

    try {
      for await (const ev of parseSse(res.body)) {
        if (ev.type === "error") {
          yield { type: "error", message: "The AI service reported an error." };
          yield { type: "done" };
          return;
        }
        if (ev.type === "content_block_start" && ev.content_block && ev.index !== undefined) {
          if (ev.content_block.type === "text") {
            blocks[ev.index] = { type: "text", text: ev.content_block.text ?? "" };
          } else if (ev.content_block.type === "tool_use") {
            blocks[ev.index] = {
              type: "tool_use",
              id: ev.content_block.id ?? "",
              name: ev.content_block.name ?? "",
              input: {},
            };
            partialJson[ev.index] = "";
          }
        } else if (ev.type === "content_block_delta" && ev.delta && ev.index !== undefined) {
          const block = blocks[ev.index];
          if (ev.delta.type === "text_delta" && block?.type === "text" && ev.delta.text) {
            block.text += ev.delta.text;
            yield { type: "text", text: ev.delta.text };
          } else if (ev.delta.type === "input_json_delta" && block?.type === "tool_use") {
            partialJson[ev.index] += ev.delta.partial_json ?? "";
          }
        } else if (ev.type === "content_block_stop" && ev.index !== undefined) {
          const block = blocks[ev.index];
          if (block?.type === "tool_use" && partialJson[ev.index]) {
            try {
              block.input = JSON.parse(partialJson[ev.index]);
            } catch {
              block.input = {};
            }
          }
        } else if (ev.type === "message_delta" && ev.delta?.stop_reason) {
          stopReason = ev.delta.stop_reason;
        }
      }
    } catch {
      yield { type: "error", message: "The AI service connection dropped." };
      yield { type: "done" };
      return;
    }

    const toolUses = blocks.filter((b): b is Extract<ContentBlock, { type: "tool_use" }> => b?.type === "tool_use");
    if (stopReason === "tool_use" && toolUses.length) {
      msgs.push({ role: "assistant", content: blocks.filter(Boolean) });
      const results: unknown[] = [];
      for (const tu of toolUses) {
        yield { type: "tool_start", name: tu.name, input: tu.input };
        let out: unknown;
        try {
          out = await opts.executeTool(tu.name, tu.input);
        } catch (e) {
          out = { error: `Tool failed: ${e instanceof Error ? e.message : String(e)}` };
        }
        yield { type: "tool_result", name: tu.name, result: out };
        results.push({
          type: "tool_result",
          tool_use_id: tu.id,
          content: JSON.stringify(out ?? null).slice(0, TOOL_RESULT_CHAR_CAP),
        });
      }
      msgs.push({ role: "user", content: results });
      continue;
    }

    yield { type: "done" };
    return;
  }

  yield { type: "error", message: "The agent hit its research step limit — try a narrower question." };
  yield { type: "done" };
}
