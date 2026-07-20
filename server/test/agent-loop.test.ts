import { describe, expect, it } from "vitest";
import { runAgent, type AgentEvent } from "../src/agent/agent.js";

function sse(events: Array<Record<string, unknown>>): Response {
  const body = events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join("");
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

const TOOL_TURN = sse([
  { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "tu_1", name: "search_applications", input: {} } },
  { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"query":"extension"}' } },
  { type: "content_block_stop", index: 0 },
  { type: "message_delta", delta: { stop_reason: "tool_use" } },
  { type: "message_stop" },
]);

const TEXT_TURN = sse([
  { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
  { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "I found " } },
  { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "3 extensions." } },
  { type: "content_block_stop", index: 0 },
  { type: "message_delta", delta: { stop_reason: "end_turn" } },
  { type: "message_stop" },
]);

describe("runAgent", () => {
  it("runs the tool loop and streams text", async () => {
    const turns = [TOOL_TURN, TEXT_TURN];
    const bodies: Array<Record<string, unknown>> = [];
    const fetchImpl = (async (_url: unknown, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)));
      return turns.shift()!;
    }) as typeof fetch;

    const events: AgentEvent[] = [];
    for await (const ev of runAgent({
      messages: [{ role: "user", content: "extensions near me?" }],
      executeTool: async (name, input) => ({ echoed: { name, input } }),
      fetchImpl,
      apiKey: "test-key",
    })) {
      events.push(ev);
    }

    const types = events.map((e) => e.type);
    expect(types).toEqual(["tool_start", "tool_result", "text", "text", "done"]);
    const start = events[0] as { name: string; input: { query: string } };
    expect(start.name).toBe("search_applications");
    expect(start.input.query).toBe("extension");
    // Second API call must carry the assistant tool_use turn + tool_result
    const second = bodies[1] as { messages: Array<{ role: string }> };
    expect(second.messages.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
  });

  it("yields error when there is no API key", async () => {
    const events: AgentEvent[] = [];
    for await (const ev of runAgent({
      messages: [{ role: "user", content: "hi" }],
      executeTool: async () => ({}),
      apiKey: "",
    })) {
      events.push(ev);
    }
    expect(events[0].type).toBe("error");
  });
});
