import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { AdmissionCoordinator } from "../../src/admission/coordinator.js";
import { ConversationError } from "../../src/conversation/errors.js";
import {
  ConversationRunner,
  callConversationTool,
  generationLive,
  type ConversationGeneration,
  type ConversationTool,
} from "../../src/conversation/runner.js";
import { recoverPartialToolArgs } from "../../src/conversation/tool-args.js";
import type { Queryable } from "../../src/db/pg.js";
import type { ToolCall } from "../../src/db/schema/index.js";
import type { ModelEvent } from "../../src/llm/completion.js";
import { PolicyError, UNLIMITED, type OrgPolicy } from "../../src/policy/index.js";
import { completionReply } from "../helpers/generation.js";
import { overflowStream, sseApp } from "../helpers/sse.js";

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

/** The context a probe tool is called in: the seq its result takes. */
type ProbeContext = { upcoming: number };

function tool(handler: ConversationTool<ProbeContext>["handler"]): ConversationTool<ProbeContext> {
  return {
    name: "probe",
    schema: { type: "function", function: { name: "probe", description: "", parameters: { type: "object" } } },
    handler,
  };
}

function generation(
  tools: Map<string, ConversationTool<ProbeContext>> = new Map(),
): ConversationGeneration<ProbeContext> {
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
    toolContext: (upcoming) => ({ upcoming }),
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

/** A database that refuses every query. */
function unreachableDatabase(): Queryable {
  return {
    query: async () => {
      throw new Error("connection refused");
    },
  } as unknown as Queryable;
}

/** The generation's events up to `generation.finished`, read from its stream without awaiting its task. */
async function eventsUntilFinished(
  runner: ConversationRunner,
  turn: ConversationGeneration<ProbeContext>,
): Promise<Array<[string, Record<string, unknown>]>> {
  const queue = runner.subscribe(turn.session.id);
  runner.start(turn);
  const events: Array<[string, Record<string, unknown>]> = [];
  while (events.at(-1)?.[0] !== "generation.finished") {
    events.push(await queue.get());
  }
  return events;
}

/** What reaches `unhandledRejection` while `work` runs, and in the moment after it. */
async function unhandledRejectionsDuring<T>(work: () => Promise<T>): Promise<{ result: T; rejections: unknown[] }> {
  const rejections: unknown[] = [];
  const sentinel = (reason: unknown) => {
    rejections.push(reason);
  };
  process.on("unhandledRejection", sentinel);
  try {
    const result = await work();
    await new Promise((resolve) => setTimeout(resolve, 20));
    return { result, rejections };
  } finally {
    process.off("unhandledRejection", sentinel);
  }
}

async function publishedEvents(
  runner: ConversationRunner,
  turn: ConversationGeneration<ProbeContext>,
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
  let context: ProbeContext | null = null;
  const echoing = tool(async (bound, args) => {
    context = bound;
    return { args };
  });
  const turn = generation(new Map([["probe", echoing]]));
  const result = await callConversationTool(turn, toolCall("probe", '{"a":1}'), 4, "tool_calls");
  assert.deepEqual(result, { args: { a: 1 } });
  assert.deepEqual(context, { upcoming: 4 });
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

test("admission_refusal_leaves_the_session_idle_and_publishes_finished", async () => {
  const { db, queries } = emptyDatabase();
  const admission = new AdmissionCoordinator(1);
  await admission.acquire("agent", "run-1", "org-1");
  const runner = new ConversationRunner({ db, kind: "studio", admission, stubHint: "hint" });
  const events = await publishedEvents(runner, generation());
  assert.deepEqual(
    events.map(([event]) => event),
    ["generation.started", "session.error", "generation.finished"],
  );
  assert.match(String(events[1]?.[1].detail), /generation limit/);
  const reset = queries.filter(
    ({ text, params }) => text.startsWith("UPDATE studio_sessions") && params.includes("idle"),
  );
  assert.equal(reset.length, 1);
  assert.equal(admission.isBusy("agent", "run-1"), true);
});

test("a_throw_in_the_background_task_is_recorded_not_crashed", { timeout: 5_000 }, async () => {
  const { db, queries } = emptyDatabase();
  const suspended: OrgPolicy = {
    standing: async () => ({ limits: UNLIMITED, blocked: new PolicyError(402, "plan suspended") }),
  };
  const admission = new AdmissionCoordinator();
  const runner = new ConversationRunner({ db, kind: "studio", admission, policy: suspended, stubHint: "hint" });
  const { result: events, rejections } = await unhandledRejectionsDuring(() =>
    eventsUntilFinished(runner, generation()),
  );
  assert.deepEqual(rejections, []);
  assert.deepEqual(
    events.map(([event]) => event),
    ["generation.started", "session.error", "generation.finished"],
  );
  assert.equal(events[1]?.[1].detail, "plan suspended");
  const recorded = queries.filter(({ params }) => JSON.stringify(params).includes("plan suspended"));
  assert.equal(recorded.length, 1);
  const reset = queries.filter(
    ({ text, params }) => text.startsWith("UPDATE studio_sessions") && params.includes("idle"),
  );
  assert.equal(reset.length, 1);
  assert.equal(admission.isBusy("studio", "session-1"), false);
});

test("a_throw_the_database_refuses_to_record_still_finishes_the_stream_without_a_crash", { timeout: 5_000 }, async () => {
  const runner = new ConversationRunner({
    db: unreachableDatabase(),
    kind: "builder",
    admission: new AdmissionCoordinator(),
    stubHint: "hint",
  });
  const { result: events, rejections } = await unhandledRejectionsDuring(() =>
    eventsUntilFinished(runner, generation()),
  );
  assert.deepEqual(rejections, []);
  assert.deepEqual(
    events.map(([event]) => event),
    ["generation.started", "generation.finished"],
  );
});

test("boot_reconcile_returns_an_interrupted_session_to_idle_and_clears_its_start", async () => {
  const { db, queries } = emptyDatabase();
  const runner = new ConversationRunner({ db, kind: "builder", admission: new AdmissionCoordinator(), stubHint: "hint" });
  await runner.reconcile({ id: "session-1", generation_state: "generating", generation_number: 2 } as never);
  const reset = queries.filter(({ text }) => text.startsWith("UPDATE builder_sessions"));
  assert.equal(reset.length, 1);
  assert.match(String(reset[0]?.text), /generation_token = \$\d+, generation_started_at = \$\d+/);
  assert.deepEqual(reset[0]?.params.slice(2), ["idle", null, null]);
});

test("cancel_of_an_idle_session_is_a_noop", async () => {
  const db = {
    query: async (text: string, params: unknown[] = []) =>
      text.startsWith("INSERT INTO studio_messages") ? { rows: [{ seq: params[1], payload: params[3] }] } : { rows: [] },
  } as unknown as Queryable;
  const runner = new ConversationRunner({
    db,
    kind: "studio",
    admission: new AdmissionCoordinator(),
    stubHint: "hint",
    credentials: { modelCredentials: async () => ({ apiKey: "key" }) },
  });
  generationLive.streamCompletion = async function* (): AsyncGenerator<ModelEvent> {
    yield ["done", completionReply("answered")];
  };
  runner.cancel("session-1");
  const events = await publishedEvents(runner, generation());
  assert.deepEqual(
    events.map(([event]) => event),
    ["generation.started", "message.committed", "generation.finished"],
  );
});

test("a_slow_coach_subscriber_is_closed_not_silenced", async () => {
  const { db } = emptyDatabase();
  const runner = new ConversationRunner({
    db,
    kind: "studio",
    admission: new AdmissionCoordinator(),
    stubHint: "hint",
  });
  const { app, opened } = sseApp(
    () => runner.subscribe("s_1"),
    (queue) => runner.unsubscribe("s_1", queue),
  );
  const { body, queue } = await overflowStream(app, opened, () =>
    Array.from({ length: 8192 }, () =>
      runner.publish("s_1", "assistant.delta", { session_id: "s_1", text: "x" }),
    ),
  );
  assert.equal(queue.dropped, true);
  assert.ok(body.startsWith(": connected\n\n"), body.slice(0, 40));
  await runner.publish("s_1", "assistant.delta", { session_id: "s_1", text: "after" });
  assert.equal(queue.size, 0, "the dropped subscriber is no longer sent events");
  await app.close();
});
