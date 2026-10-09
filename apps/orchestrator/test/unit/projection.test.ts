import assert from "node:assert/strict";
import { test } from "node:test";
import { promptHash } from "../../src/prompts/index.js";
import {
  AGENT_TOOL_RESULT_STUB_HINT,
  TOOL_RESULT_STUB_MIN_BYTES,
  generationOf,
  keepGenerationFloor,
  projectToolResults,
  stubToolResultPayload,
  toolResultBytes,
} from "../../src/conversation/projection.js";

function row(
  seq: number,
  generation: number,
  payload: Record<string, unknown>,
  metadata: Record<string, unknown> = {},
): Record<string, unknown> {
  return { seq, generation, payload, metadata };
}

function toolContent(messages: Array<Record<string, unknown>>, index: number): string {
  return String(messages.filter((item) => item.role === "tool")[index]?.content ?? "");
}

test("generationOf reads the column, then integer metadata, then zero", () => {
  assert.equal(generationOf({ generation: 4 }), 4);
  assert.equal(generationOf({ metadata: { generation: 3 } }), 3);
  assert.equal(generationOf({ generation: 1.5, metadata: { generation: "x" } }), 0);
  assert.equal(generationOf({}), 0);
});

test("toolResultBytes measures a string, JSON object, or missing content", () => {
  assert.equal(toolResultBytes({ payload: { content: "ab" } }), 2);
  assert.equal(toolResultBytes({ payload: { content: { a: 1 } } }), Buffer.byteLength('{"a":1}', "utf8"));
  assert.equal(toolResultBytes({ payload: { content: null } }), 0);
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

test("stubToolResultPayload copies path, range, and optional content hash", () => {
  const source = row(
    9,
    1,
    { role: "tool", content: "body" },
    { tool_name: "file_read", path: "src/a.ts", range: [1, 4] },
  );
  const hashed = stubToolResultPayload(source, AGENT_TOOL_RESULT_STUB_HINT, {
    includeContentHash: true,
  });
  const stub = JSON.parse(String(hashed.content)) as Record<string, unknown>;
  assert.equal(stub.path, "src/a.ts");
  assert.deepEqual(stub.range, [1, 4]);
  assert.equal(stub.content_hash, promptHash("body"));
});

test("keep 1 stubs previous-generation results above the size floor", () => {
  const large = "x".repeat(TOOL_RESULT_STUB_MIN_BYTES);
  const messages = projectToolResults({
    history: [
      row(0, 0, { role: "system", content: "sys" }),
      row(1, 1, { role: "tool", tool_call_id: "old", content: large }, { tool_name: "file_read", path: "src/a.ts" }),
      row(2, 2, { role: "user", content: "again" }),
      row(3, 2, { role: "tool", tool_call_id: "new", content: large }, { tool_name: "file_read", path: "src/b.ts" }),
    ],
    currentGeneration: 2,
    keepGenerations: 1,
    hint: AGENT_TOOL_RESULT_STUB_HINT,
    minStubBytes: TOOL_RESULT_STUB_MIN_BYTES,
  });
  assert.match(toolContent(messages, 0), /"stub":true/);
  assert.match(toolContent(messages, 0), /file_read/);
  assert.match(toolContent(messages, 0), /src\/a\.ts/);
  assert.match(toolContent(messages, 0), /working tree may have changed/);
  assert.equal(toolContent(messages, 1), large);
});

test("keep 2 leaves the previous generation live", () => {
  const large = "x".repeat(TOOL_RESULT_STUB_MIN_BYTES);
  const messages = projectToolResults({
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

test("results under the size floor stay as stored", () => {
  const messages = projectToolResults({
    history: [
      row(1, 1, { role: "tool", tool_call_id: "small", content: "ok" }, { tool_name: "file_edit" }),
    ],
    currentGeneration: 2,
    keepGenerations: 1,
    hint: AGENT_TOOL_RESULT_STUB_HINT,
    minStubBytes: TOOL_RESULT_STUB_MIN_BYTES,
  });
  assert.equal(toolContent(messages, 0), "ok");
});

test("budget stubs oldest live large results and keeps the last N", () => {
  const large = "x".repeat(TOOL_RESULT_STUB_MIN_BYTES);
  const messages = projectToolResults({
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
      countInputTokens(_model, next) {
        const tools = (next as Array<Record<string, unknown>>).filter((item) => item.role === "tool");
        const live = tools.filter((item) => !String(item.content).includes('"stub":true'));
        return live.length > 2 ? 9 : 1;
      },
    },
  });
  assert.match(toolContent(messages, 0), /"stub":true/);
  assert.equal(toolContent(messages, 1), large);
  assert.equal(toolContent(messages, 2), large);
});

test("budget stops at minUnstubbed even if tokens stay over the cap", () => {
  const large = "x".repeat(TOOL_RESULT_STUB_MIN_BYTES);
  const stubbed: number[] = [];
  const messages = projectToolResults({
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
      countInputTokens: () => 9,
    },
  });
  assert.deepEqual(stubbed, [1]);
  assert.match(toolContent(messages, 0), /"stub":true/);
  assert.equal(toolContent(messages, 1), large);
  assert.equal(toolContent(messages, 2), large);
});

test("reads generation from message metadata when the column is absent", () => {
  const large = "x".repeat(TOOL_RESULT_STUB_MIN_BYTES);
  const messages = projectToolResults({
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
