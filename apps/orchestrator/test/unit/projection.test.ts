import assert from "node:assert/strict";
import { test } from "node:test";
import { getEncoding } from "js-tiktoken";
import { promptHash } from "../../src/prompts/index.js";
import {
  AGENT_TOOL_RESULT_STUB_HINT,
  TOOL_RESULT_STUB_MIN_BYTES,
  generationOf,
  keepGenerationFloor,
  projectToolResults,
  stubToolResultPayload,
  toolResultBytes,
  type ProjectedRow,
} from "../../src/conversation/projection.js";
import type { MessagePayload, ToolMessage } from "../../src/db/schema/index.js";
import type { FunctionTool } from "../../src/lib/tool-schema.js";
import { TOKEN_ENCODING, countInputTokens } from "../../src/llm/tokens.js";

function row(
  seq: number,
  generation: number,
  payload: MessagePayload,
  metadata: ProjectedRow["metadata"] = {},
): ProjectedRow {
  return { seq, generation, payload, metadata };
}

function toolContent(messages: MessagePayload[], index: number): string {
  return messages.filter((item) => item.role === "tool")[index]?.content ?? "";
}

const empty: ToolMessage = { role: "tool", tool_call_id: "c", content: "" };

test("generationOf reads the column, then the metadata, then zero", () => {
  assert.equal(generationOf({ seq: 1, generation: 4, payload: empty, metadata: { generation: 3 } }), 4);
  assert.equal(generationOf({ seq: 1, payload: empty, metadata: { generation: 3 } }), 3);
  assert.equal(generationOf({ seq: 1, payload: empty, metadata: {} }), 0);
});

test("toolResultBytes measures the content", () => {
  assert.equal(toolResultBytes(row(1, 1, { ...empty, content: "ab" })), 2);
  assert.equal(toolResultBytes(row(1, 1, empty)), 0);
});

test("keepGenerationFloor is current minus keep plus one", () => {
  assert.equal(keepGenerationFloor(5, 1), 5);
  assert.equal(keepGenerationFloor(5, 2), 4);
  assert.equal(keepGenerationFloor(1, 1), 1);
});

test("keepGenerationFloor clamps invalid keep counts to one generation", () => {
  assert.equal(keepGenerationFloor(5, 0), 5);
  assert.equal(keepGenerationFloor(5, 1.5), 5);
});

test("stubToolResultPayload names the tool and carries the optional content hash", () => {
  const payload: ToolMessage = { role: "tool", tool_call_id: "c", content: "body" };
  const source = { ...row(9, 1, payload, { tool_name: "note_get" }), payload };
  const hashed = stubToolResultPayload(source, {
    hint: AGENT_TOOL_RESULT_STUB_HINT,
    includeContentHash: true,
  });
  const stub = JSON.parse(hashed.content) as Record<string, unknown>;
  assert.equal(stub.tool_name, "note_get");
  assert.equal(stub.content_hash, promptHash("body"));
});

test("keep 1 stubs previous-generation results above the size floor", async () => {
  const large = "x".repeat(TOOL_RESULT_STUB_MIN_BYTES);
  const messages = await projectToolResults({
    history: [
      row(0, 0, { role: "system", content: "sys" }),
      row(1, 1, { role: "tool", tool_call_id: "old", content: large }, { tool_name: "note_get" }),
      row(2, 2, { role: "user", content: "again" }),
      row(3, 2, { role: "tool", tool_call_id: "new", content: large }, { tool_name: "note_get" }),
    ],
    currentGeneration: 2,
    keepGenerations: 1,
    hint: AGENT_TOOL_RESULT_STUB_HINT,
    minStubBytes: TOOL_RESULT_STUB_MIN_BYTES,
  });
  assert.match(toolContent(messages, 0), /"stub":true/);
  assert.match(toolContent(messages, 0), /note_get/);
  assert.match(toolContent(messages, 0), /Call the same tool again\./);
  assert.equal(toolContent(messages, 1), large);
});

test("keep 2 leaves the previous generation live", async () => {
  const large = "x".repeat(TOOL_RESULT_STUB_MIN_BYTES);
  const messages = await projectToolResults({
    history: [
      row(1, 1, { role: "tool", tool_call_id: "a", content: large }, { tool_name: "file_read" }),
      row(2, 2, { role: "tool", tool_call_id: "b", content: large }, { tool_name: "file_read" }),
      row(3, 3, { role: "tool", tool_call_id: "c", content: large }, { tool_name: "file_read" }),
    ],
    currentGeneration: 3,
    keepGenerations: 2,
    hint: AGENT_TOOL_RESULT_STUB_HINT,
    minStubBytes: TOOL_RESULT_STUB_MIN_BYTES,
  });
  assert.match(toolContent(messages, 0), /"stub":true/);
  assert.equal(toolContent(messages, 1), large);
  assert.equal(toolContent(messages, 2), large);
});

test("results under the size floor stay as stored", async () => {
  const messages = await projectToolResults({
    history: [
      row(1, 1, { role: "tool", tool_call_id: "small", content: "ok" }, { tool_name: "shell" }),
    ],
    currentGeneration: 2,
    keepGenerations: 1,
    hint: AGENT_TOOL_RESULT_STUB_HINT,
    minStubBytes: TOOL_RESULT_STUB_MIN_BYTES,
  });
  assert.equal(toolContent(messages, 0), "ok");
});

test("budget stubs oldest live large results and keeps the last N", async () => {
  const large = "x".repeat(TOOL_RESULT_STUB_MIN_BYTES);
  const messages = await projectToolResults({
    history: [
      row(1, 2, { role: "tool", tool_call_id: "a", content: large }),
      row(2, 2, { role: "tool", tool_call_id: "b", content: large }),
      row(3, 2, { role: "tool", tool_call_id: "c", content: large }),
    ],
    currentGeneration: 2,
    keepGenerations: 1,
    hint: AGENT_TOOL_RESULT_STUB_HINT,
    minStubBytes: TOOL_RESULT_STUB_MIN_BYTES,
    minUnstubbed: 2,
    budget: {
      model: "test",
      schemas: [],
      maxInput: 1,
      async countInputTokens(_model, next) {
        const tools = (next as MessagePayload[]).filter((item) => item.role === "tool");
        const live = tools.filter((item) => !String(item.content).includes('"stub":true'));
        return live.length > 2 ? 9 : 1;
      },
    },
  });
  assert.match(toolContent(messages, 0), /"stub":true/);
  assert.equal(toolContent(messages, 1), large);
  assert.equal(toolContent(messages, 2), large);
});

test("budget stops at minUnstubbed even if tokens stay over the cap", async () => {
  const large = "x".repeat(TOOL_RESULT_STUB_MIN_BYTES);
  const stubbed: number[] = [];
  const messages = await projectToolResults({
    history: [
      row(1, 2, { role: "tool", tool_call_id: "a", content: large }),
      row(2, 2, { role: "tool", tool_call_id: "b", content: large }),
      row(3, 2, { role: "tool", tool_call_id: "c", content: large }),
    ],
    currentGeneration: 2,
    keepGenerations: 1,
    hint: AGENT_TOOL_RESULT_STUB_HINT,
    minStubBytes: TOOL_RESULT_STUB_MIN_BYTES,
    minUnstubbed: 2,
    stubbed,
    budget: {
      model: "test",
      schemas: [],
      maxInput: 1,
      countInputTokens: async () => 9,
    },
  });
  assert.deepEqual(stubbed, [1]);
  assert.match(toolContent(messages, 0), /"stub":true/);
  assert.equal(toolContent(messages, 1), large);
  assert.equal(toolContent(messages, 2), large);
});

test("reads generation from message metadata when the column is absent", async () => {
  const large = "x".repeat(TOOL_RESULT_STUB_MIN_BYTES);
  const messages = await projectToolResults({
    history: [
      {
        seq: 3,
        payload: { role: "tool", tool_call_id: "old", content: large },
        metadata: { generation: 1, tool_name: "shell" },
      },
    ],
    currentGeneration: 2,
    keepGenerations: 1,
    hint: AGENT_TOOL_RESULT_STUB_HINT,
    minStubBytes: TOOL_RESULT_STUB_MIN_BYTES,
  });
  assert.match(toolContent(messages, 0), /"stub":true/);
  assert.match(toolContent(messages, 0), /shell/);
});

test("a budget on the worker's count stubs the rows a main-thread count stubs, at the limit, under it, and in overflow", async () => {
  const reference = getEncoding(TOKEN_ENCODING);
  const referenceCount = async (
    _model: string,
    messages: readonly MessagePayload[],
    tools?: readonly FunctionTool[] | null,
  ): Promise<number> =>
    Math.max(1, reference.encode(JSON.stringify(messages) + (tools && tools.length ? JSON.stringify(tools) : "")).length);
  const body = (index: number) => `finding ${index} stays in the canonical note. `.repeat(TOOL_RESULT_STUB_MIN_BYTES / 20);
  const history = [
    row(0, 0, { role: "system", content: "sys" }),
    ...[1, 2, 3, 4].map((seq) => row(seq, 2, { role: "tool", tool_call_id: `call_${seq}`, content: body(seq) })),
  ];
  const project = async (maxInput: number, count: typeof referenceCount) => {
    const stubbed: number[] = [];
    const messages = await projectToolResults({
      history,
      currentGeneration: 2,
      keepGenerations: 1,
      hint: AGENT_TOOL_RESULT_STUB_HINT,
      minStubBytes: TOOL_RESULT_STUB_MIN_BYTES,
      minUnstubbed: 1,
      stubbed,
      budget: { model: "unknown/model", schemas: [], maxInput, countInputTokens: count },
    });
    return { messages, stubbed };
  };
  const unstubbed = await referenceCount("", history.map((item) => item.payload));
  for (const [maxInput, expected] of [
    [unstubbed, []],
    [unstubbed - 1, [1]],
    [1, [1, 2, 3]],
  ] as const) {
    const viaWorker = await project(maxInput, countInputTokens);
    assert.deepEqual(viaWorker, await project(maxInput, referenceCount));
    assert.deepEqual(viaWorker.stubbed, expected);
  }
});
