import assert from "node:assert/strict";
import { after, test } from "node:test";
import { getEncoding } from "js-tiktoken";
import {
  TOKEN_ENCODING,
  countInputTokens,
  installTokenEncodingLoader,
} from "../../src/llm/tokens.js";
import type { MessagePayload } from "../../src/db/schema/index.js";
import type { FunctionTool } from "../../src/lib/tool-schema.js";

const MODEL = "openrouter/openai/gpt-5.6-luna";

const MESSAGES: MessagePayload[] = [
  { role: "system", content: "You are an agent in a work guild." },
  { role: "user", content: "hello" },
  {
    role: "assistant",
    content: "",
    tool_calls: [
      {
        id: "call_1",
        type: "function",
        function: { name: "file_read", arguments: '{"path":"notes/weekly.md"}' },
      },
    ],
  },
  { role: "tool", tool_call_id: "call_1", content: "The weekly note keeps the canonical finding." },
];

const TOOLS: FunctionTool[] = [
  {
    type: "function",
    function: {
      name: "file_read",
      description: "Read a file from the agent's notes.",
      parameters: {
        type: "object",
        properties: { path: { type: "string" } },
        required: ["path"],
      },
    },
  },
];

function legacyCount(
  messages: readonly MessagePayload[],
  tools?: readonly FunctionTool[] | null,
): number {
  let text = JSON.stringify(messages);
  if (tools && tools.length) {
    text += JSON.stringify(tools);
  }
  return Math.max(1, getEncoding(TOKEN_ENCODING).encode(text).length);
}

after(() => {
  installTokenEncodingLoader(() => getEncoding(TOKEN_ENCODING));
});

test("countInputTokens matches a fresh encoding of the same messages and tools", () => {
  assert.equal(
    countInputTokens(MODEL, [{ role: "user", content: "hello" }]),
    legacyCount([{ role: "user", content: "hello" }]),
  );
  assert.equal(countInputTokens(MODEL, MESSAGES, null), legacyCount(MESSAGES, null));
  assert.equal(countInputTokens(MODEL, MESSAGES, []), legacyCount(MESSAGES, []));
  assert.equal(countInputTokens(MODEL, MESSAGES, TOOLS), legacyCount(MESSAGES, TOOLS));
  assert.equal(countInputTokens("unknown/model", MESSAGES, TOOLS), legacyCount(MESSAGES, TOOLS));
  assert.equal(countInputTokens(MODEL, []), legacyCount([]));
});

test("countInputTokens repeats the same count for the same input", () => {
  const first = countInputTokens(MODEL, MESSAGES, TOOLS);
  const second = countInputTokens(MODEL, MESSAGES, TOOLS);
  assert.equal(first, second);
  assert.equal(second, legacyCount(MESSAGES, TOOLS));
  assert.ok(first >= 1);
});

test("countInputTokens loads one encoding for the process", () => {
  let loads = 0;
  installTokenEncodingLoader(() => {
    loads += 1;
    return getEncoding(TOKEN_ENCODING);
  });
  try {
    const withTools = countInputTokens(MODEL, MESSAGES, TOOLS);
    const withoutTools = countInputTokens("unknown/model", [
      { role: "user", content: "hello again" },
    ]);
    assert.equal(loads, 1);
    assert.equal(withTools, legacyCount(MESSAGES, TOOLS));
    assert.equal(withoutTools, legacyCount([{ role: "user", content: "hello again" }]));
    assert.notEqual(withTools, withoutTools);
  } finally {
    installTokenEncodingLoader(() => getEncoding(TOKEN_ENCODING));
  }
});
