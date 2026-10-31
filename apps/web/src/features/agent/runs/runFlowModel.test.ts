import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildFlowSegments,
  flowStats,
  flowTimeline,
  turnReasoning,
  turnText,
  turnUsage,
} from "./runFlowModel";
import type { FlowSegment, RunError, Segment } from "./runFlowModel";

type Row = {
  id: number;
  seq: number;
  payload: Record<string, unknown>;
  metadata: Record<string, unknown>;
  created_at: string;
};

let seq = 0;
function row(payload: Record<string, unknown>, metadata: Record<string, unknown> = {}): Row {
  seq += 1;
  return {
    id: seq,
    seq,
    payload,
    metadata,
    created_at: `2026-09-21T08:00:${String(seq).padStart(2, "0")}Z`,
  };
}

function call(
  id: string,
  name: string,
  args: Record<string, unknown> = {},
): Record<string, unknown> {
  return { id, type: "function", function: { name, arguments: JSON.stringify(args) } };
}

function toolRow(
  callId: string,
  name: string,
  content: string,
  extra: Record<string, unknown> = {},
): Row {
  return row(
    { role: "tool", tool_call_id: callId, content },
    { generation: extra.generation ?? 1, tool_name: name, duration_ms: 9, error: null, ...extra },
  );
}

function assistantMeta(extra: Record<string, unknown> = {}): Record<string, unknown> {
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
      [1, "note_find", "read", "all"],
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
      {
        at: "2026-09-21T08:01:00Z",
        generation: 2,
        operation: "generation.cancelled",
        message: "cancelled",
      },
      {
        at: "2026-09-21T08:02:00Z",
        generation: 7,
        operation: "llm.complete",
        message: "provider down",
      },
      { at: "2026-09-21T08:03:00Z", operation: "workspace.create", message: "no generation" },
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
    row({ role: "user", content: "Memory: this wake…" }, { generation: 1, source: "memory" }),
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
  assert.deepEqual(turnUsage(row({ role: "assistant" }, assistantMeta())), {
    input_tokens: 1000,
    output_tokens: 50,
    cache_read_tokens: 0,
  });
  assert.deepEqual(turnUsage(row({ role: "assistant" }, { usage: [1000] })), {});
  assert.deepEqual(turnUsage(null), {});
});

test("flowStats sums time, tokens, cost, and counts errors and running calls", () => {
  const { segments } = buildFlowSegments(sampleMessages(), {
    ...run,
    errors: [{ generation: 1, operation: "generation.max_steps", message: "max_steps reached" }],
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
