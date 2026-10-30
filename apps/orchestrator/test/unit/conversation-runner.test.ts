import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { AdmissionCoordinator } from "../../src/admission/coordinator.js";
import { ConversationError } from "../../src/conversation/errors.js";
import {
  ConversationRunner,
  callConversationTool,
  generationLive,
  recoverPartialToolArgs,
  type ConversationGeneration,
  type ConversationTool,
} from "../../src/conversation/runner.js";
import type { Queryable } from "../../src/db/pg.js";
import type { ToolCall } from "../../src/db/schema/index.js";
import type { ModelEvent } from "../../src/llm/completion.js";

const live = { ...generationLive };

beforeEach(() => {
  generationLive.countInputTokens = () => 1;
});

afterEach(() => {
  Object.assign(generationLive, live);
});

function toolCall(name: string, args = "{}"): ToolCall {
  return { id: "call-1", type: "function", function: { name, arguments: args } };
}

function tool(handler: ConversationTool["handler"]): ConversationTool {
  return { name: "probe", schema: {}, handler };
}

function generation(tools: Map<string, ConversationTool> = new Map()): ConversationGeneration {
  return {
    session: {
      id: "session-1",
      org_id: "org-1",
      config_snapshot: { model: "openai/gpt-5", temperature: 0 },
    } as never,
    user: {} as never,
    generation: 1,
    generationContext: "context",
    tools,
    toolContext: { bound: false },
    maxTokens: 100,
    maxSteps: 3,
    maxToolCalls: 3,
    maxInput: 1000,
  };
}

/** A database that answers every query with no rows, and records each one. */
function emptyDatabase(): { db: Queryable; queries: Array<{ text: string; params: unknown[] }> } {
  const queries: Array<{ text: string; params: unknown[] }> = [];
  const db = {
    query: async (text: string, params: unknown[] = []) => {
      queries.push({ text, params });
      return { rows: [] };
    },
  } as unknown as Queryable;
  return { db, queries };
}

async function publishedEvents(
  runner: ConversationRunner,
  turn: ConversationGeneration,
): Promise<Array<[string, Record<string, unknown>]>> {
  const queue = runner.subscribe(turn.session.id);
  runner.start(turn);
  await runner.wait(turn.session.id);
  const events: Array<[string, Record<string, unknown>]> = [];
  while (!queue.empty()) {
    events.push(await queue.get());
  }
  return events;
}

test("a tool that throws ends the call with its error message as the result", async () => {
  const failing = tool(async () => {
    throw new ConversationError(422, "agent not found");
  });
  const result = await callConversationTool(
    generation(new Map([["probe", failing]])),
    toolCall("probe"),
    4,
    "tool_calls",
  );
  assert.deepEqual(result, { error: "agent not found" });
});

test("a tool that throws something other than an Error ends the call with a generic error", async () => {
  const failing = tool(async () => {
    throw "broken";
  });
  const result = await callConversationTool(
    generation(new Map([["probe", failing]])),
    toolCall("probe"),
    4,
    "tool_calls",
  );
  assert.deepEqual(result, { error: "tool failed" });
});

test("a tool call is answered with the handler's result in the bound tool context", async () => {
  const echoing = tool(async (context, args) => ({ context, args }));
  const turn = {
    ...generation(new Map([["probe", echoing]])),
    bindToolContext: (upcoming: number) => ({ upcoming }),
  };
  const result = await callConversationTool(turn, toolCall("probe", '{"a":1}'), 4, "tool_calls");
  assert.deepEqual(result, { context: { upcoming: 4 }, args: { a: 1 } });
});

test("a call to an unknown tool, or with arguments cut short, is answered with an error", async () => {
  const echoing = tool(async () => ({ ok: true }));
  const turn = generation(new Map([["probe", echoing]]));
  assert.deepEqual(await callConversationTool(turn, toolCall("missing"), 4, "tool_calls"), {
    error: "unknown tool missing",
  });
  const truncated = await callConversationTool(turn, toolCall("probe", '{"a":'), 4, "length");
  assert.match(String(truncated.error), /output truncated at max_tokens/);
});

test("a recovered argument whose escapes are not JSON keeps the text as written", () => {
  const recovered = recoverPartialToolArgs(
    '{"agent_id":"a\\qb","rationale":"keep \\x as is","proposed_content":"Sta',
  );
  assert.equal(recovered.agent_id, "a\\qb");
  assert.equal(recovered.rationale, "keep \\x as is");
});

test("a recovered argument with JSON escapes is decoded", () => {
  const recovered = recoverPartialToolArgs(
    '{"agent_id":"a_1","rationale":"line\\nbreak \\u00e9","proposed_content":"Sta',
  );
  assert.equal(recovered.agent_id, "a_1");
  assert.equal(recovered.rationale, "line\nbreak é");
});

test("a completion the provider does not return records its message as the session's error", async () => {
  const { db, queries } = emptyDatabase();
  const runner = new ConversationRunner({
    db,
    kind: "studio",
    admission: new AdmissionCoordinator(),
    stubHint: "hint",
  });
  const events = await publishedEvents(runner, generation());
  const errors = events.filter(([event]) => event === "session.error");
  assert.equal(errors.length, 1);
  assert.equal(errors[0]?.[1].detail, "connect a OpenAI key on Model keys");
  const recorded = queries.filter(({ params }) =>
    JSON.stringify(params).includes("connect a OpenAI key on Model keys"),
  );
  assert.equal(recorded.length, 1);
  assert.equal(events.at(-1)?.[0], "generation.finished");
});

test("a completion cancelled while the model answers ends the generation without an error", async () => {
  const { db } = emptyDatabase();
  const runner = new ConversationRunner({
    db,
    kind: "studio",
    admission: new AdmissionCoordinator(),
    stubHint: "hint",
    credentials: { modelCredentials: async () => ({ apiKey: "key" }) },
  });
  const turn = generation();
  generationLive.streamCompletion = async function* (): AsyncGenerator<ModelEvent> {
    runner.cancel(turn.session.id);
    await new Promise(() => {});
    yield ["delta", "never streamed: the cancel wins the race"];
  };
  const events = await publishedEvents(runner, turn);
  assert.deepEqual(
    events.map(([event]) => event),
    ["generation.started", "generation.finished"],
  );
});
