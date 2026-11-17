import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildFlowSegments,
  flowStats,
  stepCostUsd,
  flowTimeline,
  turnReasoning,
  turnText,
  turnUsage,
  replyUsage,
  usageTitle,
} from "./runFlowModel";
import type { FlowSegment, Segment } from "./runFlowModel";
import type {
  MessageMetadata,
  MessagePayload,
  RunError,
  RunMessage,
  ToolCall,
} from "../../../api/types/runs";

type Row = RunMessage;

let seq = 0;
/** A message row; its stored cost is a model reply's `cost_usd` unless `cost_usd` names another. */
function row(
  payload: MessagePayload,
  metadata: MessageMetadata = {},
  cost_usd: number | null = metadata.cost_usd ?? null,
): Row {
  seq += 1;
  return {
    id: seq,
    seq,
    payload,
    metadata,
    created_at: `2026-09-21T08:00:${String(seq).padStart(2, "0")}Z`,
    cost_usd,
  };
}

function call(id: string, name: string, args: Record<string, unknown> = {}): ToolCall {
  return { id, type: "function", function: { name, arguments: JSON.stringify(args) } };
}

function toolRow(callId: string, name: string, content: string, extra: MessageMetadata = {}): Row {
  return row(
    { role: "tool", tool_call_id: callId, content },
    { generation: extra.generation ?? 1, tool_name: name, duration_ms: 9, error: null, ...extra },
  );
}

function assistantMeta(extra: MessageMetadata = {}): MessageMetadata {
  return {
    generation: 1,
    latency_ms: 1200,
    usage: { input_tokens: 1000, output_tokens: 50, cache_read_tokens: 0 },
    cost_usd: 0.01,
    finish_reason: "tool_calls",
    ...extra,
  };
}

function flowAt(segments: readonly Segment<Row>[], index: number): FlowSegment<Row> {
  const segment = segments[index];
  assert.ok(segment?.type === "flow");
  return segment;
}

const run = { id: "r_1", errors: [] as RunError[], config_snapshot: { mcp: [], tools: [] } };

/** A run error recorded at a time, in a generation, by the operation that failed. */
function runError(at: string, generation: number, operation: string, message: string): RunError {
  return { at, generation, operation, error_type: "RunError", message };
}

function sampleMessages(): Row[] {
  seq = 0;
  return [
    row({ role: "system", content: "prompt" }),
    row({ role: "user", content: "hello" }, { generation: 1 }),
    row(
      {
        role: "assistant",
        content: "",
        tool_calls: [
          call("c1", "note_find", { query: "thesis" }),
          call("c2", "record_add", { collection: "deals", body: { name: "k" } }),
        ],
      },
      assistantMeta({ reasoning: "look first, then write" }),
    ),
    toolRow("c1", "note_find", '{"notes":[],"prefixes":[]}'),
    toolRow("c2", "record_add", "ERROR: collection deals not found\n\nremaining_tool_calls: 48", {
      error: "collection deals not found",
    }),
    row(
      {
        role: "assistant",
        content: "Retrying with the right collection.",
        tool_calls: [call("c3", "memory_write")],
      },
      assistantMeta(),
    ),
    toolRow("c3", "memory_write", "ok\n\nremaining_tool_calls: 47", { duration_ms: 18 }),
    row({ role: "assistant", content: "done" }, assistantMeta({ finish_reason: "stop" })),
    row({ role: "user", content: "again" }, { generation: 2 }),
    row(
      { role: "assistant", content: "", tool_calls: [call("c4", "script_run", { name: "one" })] },
      assistantMeta({ generation: 2 }),
    ),
  ];
}

test("buildFlowSegments keeps steps and batches apart and interleaves plain rows", () => {
  const { segments, unattachedErrors } = buildFlowSegments(sampleMessages(), run);
  assert.deepEqual(
    segments.map((segment) =>
      segment.type === "flow"
        ? `flow:${segment.generation}`
        : `message:${segment.msg.payload.role}`,
    ),
    ["message:system", "message:user", "flow:1", "message:assistant", "message:user", "flow:2"],
  );
  const first = flowAt(segments, 2);
  assert.equal(first.steps.length, 2);
  assert.deepEqual(
    first.steps.map((step) => step.index),
    [1, 2],
  );
  assert.deepEqual(
    first.steps[0]?.calls.map((item) => [
      item.position,
      item.info.name,
      item.info.kind,
      item.info.level,
    ]),
    [
      [1, "note_find", "read", null],
      [2, "record_add", "write", "org"],
    ],
  );
  assert.equal(first.steps[0]?.calls[1]?.error, "collection deals not found");
  assert.equal(first.steps[0]?.calls[0]?.error, null);
  assert.equal(first.steps[1]?.calls[0]?.info.kind, "memory");
  assert.equal(turnReasoning(first.steps[0]?.turn), "look first, then write");
  assert.equal(turnText(first.steps[1]?.turn), "Retrying with the right collection.");
  const second = flowAt(segments, 5);
  assert.equal(second.steps[0]?.index, 1);
  assert.equal(second.steps[0]?.calls[0]?.result, null);
  assert.deepEqual(unattachedErrors, []);
});

test("run errors attach to the flow of their generation, others stay unattached", () => {
  const withErrors = {
    ...run,
    errors: [
      runError("2026-09-21T08:01:00Z", 2, "generation.cancelled", "cancelled"),
      runError("2026-09-21T08:02:00Z", 7, "llm.complete", "provider down"),
      runError("2026-09-21T08:03:00Z", 0, "workspace.create", "no generation"),
    ],
  };
  const { segments, unattachedErrors } = buildFlowSegments(sampleMessages(), withErrors);
  const second = flowAt(segments, 5);
  assert.deepEqual(
    second.errors.map((entry) => entry.operation),
    ["generation.cancelled"],
  );
  assert.deepEqual(
    unattachedErrors.map((entry) => entry.operation),
    ["llm.complete", "workspace.create"],
  );
});

test("a user row inside a generation splits the flow but keeps step numbering", () => {
  seq = 0;
  const messages = [
    row({ role: "user", content: "wake" }, { generation: 1, source: "schedule" }),
    row({ role: "assistant", content: "", tool_calls: [call("c1", "note_find")] }, assistantMeta()),
    toolRow("c1", "note_find", "{}"),
    row(
      { role: "assistant", content: "done without memory" },
      assistantMeta({ finish_reason: "stop" }),
    ),
    row({ role: "user", content: "Memory: this wake…" }, { generation: 1, source: "ui" }),
    row(
      { role: "assistant", content: "", tool_calls: [call("c2", "memory_write")] },
      assistantMeta(),
    ),
    toolRow("c2", "memory_write", "ok"),
  ];
  const { segments } = buildFlowSegments(messages, run);
  const flows = segments.filter((segment): segment is FlowSegment<Row> => segment.type === "flow");
  assert.equal(flows.length, 2);
  assert.deepEqual(
    flows[0]?.steps.map((step) => step.index),
    [1],
  );
  assert.deepEqual(
    flows[1]?.steps.map((step) => step.index),
    [3],
  );
});

test("a tool result without a matching call becomes its own step", () => {
  seq = 0;
  const messages = [
    toolRow("ghost", "script_run", "ERROR: execution interrupted", {
      error: "execution interrupted",
    }),
  ];
  const { segments } = buildFlowSegments(messages, run);
  const flow = flowAt(segments, 0);
  assert.equal(flow.type, "flow");
  assert.equal(flow.steps[0]?.turn, null);
  assert.equal(flow.steps[0]?.index, null);
  assert.equal(flow.steps[0]?.calls[0]?.info.kind, "execute");
  assert.equal(flow.steps[0]?.calls[0]?.error, "execution interrupted");
});

test("a tool result recorded twice for one call gets one step", () => {
  seq = 0;
  const messages = [toolRow("ghost", "note_get", "a"), toolRow("ghost", "note_get", "a")];
  const flow = flowAt(buildFlowSegments(messages, run).segments, 0);
  assert.equal(flow.steps.length, 1);
});

test("each tool result that names no call gets a step of its own", () => {
  seq = 0;
  const messages = [toolRow("", "note_get", "a"), toolRow("", "note_get", "b")];
  const flow = flowAt(buildFlowSegments(messages, run).segments, 0);
  assert.equal(flow.steps.length, 2);
  assert.equal(flow.steps[0]?.calls[0]?.info.name, "note_get");
});

test("a turn's usage is the object it recorded, and empty otherwise", () => {
  seq = 0;
  assert.deepEqual(turnUsage(row({ role: "assistant", content: "" }, assistantMeta())), {
    input_tokens: 1000,
    output_tokens: 50,
    cache_read_tokens: 0,
  });
  assert.deepEqual(turnUsage(row({ role: "assistant", content: "" }, { generation: 1 })), {});
  assert.deepEqual(turnUsage(null), {});
});

test("flowStats sums time, tokens, cost, and counts errors and running calls", () => {
  const { segments } = buildFlowSegments(sampleMessages(), {
    ...run,
    errors: [runError("2026-09-21T08:01:00Z", 1, "generation.max_steps", "max_steps reached")],
  });
  const first = flowStats(flowAt(segments, 2));
  assert.equal(first.steps, 2);
  assert.equal(first.calls, 3);
  assert.equal(first.toolErrors, 1);
  assert.equal(first.errors, 2);
  assert.equal(first.running, 0);
  assert.equal(first.modelMs, 2400);
  assert.equal(first.toolMs, 36);
  assert.equal(first.inputTokens, 2000);
  assert.equal(first.outputTokens, 100);
  assert.equal(first.costUsd, 0.02);
  assert.equal(first.kinds, "memory · read · write");
  assert.equal(first.reasoning, 1);
  const second = flowStats(flowAt(segments, 5));
  assert.equal(second.running, 1);
  assert.equal(second.errors, 0);
});

test("a step's cost adds its tool results' stored costs to its model reply's", () => {
  seq = 0;
  const messages = [
    row({ role: "user", content: "find the price" }, { generation: 1 }),
    row(
      { role: "assistant", content: "", tool_calls: [call("b1", "browse", { task: "price" })] },
      assistantMeta(),
    ),
    row(
      { role: "tool", tool_call_id: "b1", content: "OK: 12 EUR" },
      { generation: 1, tool_name: "browse", duration_ms: 9, error: null },
      0.04,
    ),
  ];
  const { segments } = buildFlowSegments(messages, run);
  const flow = flowAt(segments, 1);
  const step = flow.steps[0];
  assert.ok(step);
  assert.equal(stepCostUsd(step), 0.01 + 0.04);
  assert.equal(flowStats(flow).costUsd, 0.01 + 0.04);
});

test("flowTimeline orders model latency before each step's tool durations", () => {
  const { segments } = buildFlowSegments(sampleMessages(), run);
  const { segments: timeline, total } = flowTimeline(flowAt(segments, 2));
  assert.deepEqual(
    timeline.map((segment) => [segment.kind, segment.ms]),
    [
      ["model", 1200],
      ["read", 9],
      ["write", 9],
      ["model", 1200],
      ["memory", 18],
    ],
  );
  assert.equal(total, 2436);
  assert.equal(timeline[4]?.label, "Step 2 · memory_write");
});

test("a subscription agent's harness turn reads as a flow of its own tools' calls and a reply", () => {
  const harness = { generation: 1, from_harness: "claude-code" as const };
  const rows = [
    row(
      { role: "user", content: "Make the greeting name the guild." },
      { generation: 1, source: "ui" },
    ),
    row(
      {
        role: "assistant",
        content: "I'll look first.",
        tool_calls: [call("toolu_01", "Read", { file_path: "greet.py" })],
      },
      harness,
    ),
    toolRow("toolu_01", "Read", "1\tprint('hello')\n", harness),
    row(
      {
        role: "assistant",
        content: "",
        tool_calls: [call("toolu_02", "Bash", { command: "python3 greet.py" })],
      },
      harness,
    ),
    toolRow("toolu_02", "Bash", "hello, guild", harness),
    row({ role: "assistant", content: "Changed the greeting." }, harness),
  ];
  const { segments } = buildFlowSegments(rows, {
    id: "r1",
    errors: [],
    config_snapshot: { tools: [], mcp: [] },
  });
  assert.deepEqual(
    segments.map((segment) => segment.type),
    ["message", "flow", "message"],
  );
  const flow = segments[1] as FlowSegment;
  assert.deepEqual(
    flow.steps.flatMap((step) =>
      step.calls.map((item) => [item.info.name, item.info.kind, item.error]),
    ),
    [
      ["Read", "read", null],
      ["Bash", "execute", null],
    ],
  );
});

test("a harness turn that ended before its CLI reported its total notes the model calls' tokens as a floor, or that none were reported", () => {
  const usage = { input_tokens: 900, output_tokens: 100, cache_read_tokens: 0 };
  const partial = row(
    { role: "assistant", content: "" },
    { generation: 1, from_harness: "claude-code", usage, cost_usd: 0, cost_source: "subscription", usage_extent: "partial" },
  );
  assert.deepEqual(replyUsage(partial), {
    label: "at least 1.0k tok · on the subscription",
    title: "900 in · 100 out. The turn ended before its CLI reported its total: these are the model calls it reported.",
  });
  const none = row({ role: "assistant", content: "" }, { generation: 1, from_harness: "cursor", usage_extent: "none" });
  assert.deepEqual(replyUsage(none), { label: "tokens not reported", title: "The CLI reported none of this turn's tokens." });
});

test("a harness turn on the subscription notes its tokens on its reply, and prices none of its steps", () => {
  const usage = { input_tokens: 9120, output_tokens: 212, cache_read_tokens: 4096, cache_write_tokens: 12 };
  const reply = row(
    { role: "assistant", content: "Changed the greeting." },
    { generation: 1, from_harness: "codex", usage, cost_usd: 0, cost_source: "subscription" },
  );
  assert.deepEqual(replyUsage(reply), {
    label: "9.3k tok · on the subscription",
    title: "9,120 in · 212 out · 4,096 cached · 12 cache writes",
  });
  const priced = row(
    { role: "assistant", content: "Done." },
    { generation: 1, usage: { input_tokens: 100, output_tokens: 20, cache_read_tokens: 0 }, cost_usd: 0.002, cost_source: "catalog" },
  );
  assert.deepEqual(replyUsage(priced), { label: "120 tok · $0.0020", title: "100 in · 20 out" });
  assert.equal(replyUsage(row({ role: "assistant", content: "Hi." }, { generation: 1, from_harness: "codex" })), null);

  const turn = row(
    { role: "assistant", content: "", tool_calls: [call("c1", "command_execution", { command: "ls" })] },
    { generation: 1, from_harness: "codex", usage, cost_usd: 0, cost_source: "subscription" },
  );
  assert.equal(stepCostUsd({ index: 1, turn, calls: [] }), null, "the subscription's cost is no price");
  assert.equal(usageTitle({ input_tokens: 5, output_tokens: 1, cache_read_tokens: 0 }), "5 in · 1 out");
});
