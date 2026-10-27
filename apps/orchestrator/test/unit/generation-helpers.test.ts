import assert from "node:assert/strict";
import { test } from "node:test";
import { encryptPayload } from "../../src/credentials/crypto.js";
import {
  INTERRUPTED_CONTENT,
  executedToolCalls,
  interruptionRecord,
  pendingToolCalls,
} from "../../src/generation/tool-calls.js";
import { configSnapshot } from "../../src/generation/snapshot.js";
import { mcpIndex } from "../../src/generation/offered-tools.js";
import { mcpRedactions } from "../../src/generation/run-secrets.js";
import { workspaceMaxMib } from "../../src/generation/workspace.js";
import { offeredToolNames } from "../../src/toolbox/offered.js";
import { HEX_MASTER_KEY } from "../helpers/env.js";
import { AGENT_CONFIG } from "../helpers/generation.js";

test("workspaceMaxMib uses a positive integer env value and otherwise the default", () => {
  assert.equal(workspaceMaxMib({ WORKSPACE_MAX_MIB: "512" }), 512);
  assert.equal(workspaceMaxMib({ WORKSPACE_MAX_MIB: "0" }), 10240);
  assert.equal(workspaceMaxMib({}), 10240);
});

test("offeredToolNames drops memory, schedule, and secret_request when those flags are off", () => {
  const names = offeredToolNames(
    ["note_find", "memory_write", "schedule_list", "secret_request"],
    { memory: false, schedules: false, direct: false },
  );
  assert.deepEqual(names, ["note_find", "report_issue"]);
});

test("pendingToolCalls ignores assistant calls without ids and keeps first-seen order", () => {
  const pending = pendingToolCalls([
    {
      payload: {
        role: "assistant",
        tool_calls: [
          { function: { name: "note_find" } },
          { id: "", function: { name: "note_get" } },
          { id: "call_b", function: { name: "note_write" } },
          { id: "call_a", function: { name: "note_find" } },
        ],
      },
      metadata: { generation: 2 },
    },
  ]);
  assert.deepEqual(
    pending.map(([call]) => call.id),
    ["call_b", "call_a"],
  );
});

test("pendingToolCalls leaves unmatched tool rows out of the pending map", () => {
  const pending = pendingToolCalls([
    {
      payload: {
        role: "assistant",
        tool_calls: [{ id: "call_1", function: { name: "note_find" } }],
      },
      metadata: { generation: 1 },
    },
    { payload: { role: "tool", tool_call_id: "call_other", content: "ok" } },
  ]);
  assert.equal(pending.length, 1);
  assert.equal(pending[0]?.[0].id, "call_1");
});

test("executedToolCalls counts tool role rows only", () => {
  assert.equal(
    executedToolCalls([
      { payload: { role: "assistant" } },
      { payload: { role: "tool" } },
      { payload: { role: "tool" } },
      { payload: { role: "user" } },
    ]),
    2,
  );
});

test("interruptionRecord writes interrupted content and exit_code for shell", () => {
  const [payload, metadata] = interruptionRecord(
    { id: "call_1", function: { name: "shell" } },
    4,
  );
  assert.equal(payload.content, INTERRUPTED_CONTENT);
  assert.equal(payload.tool_call_id, "call_1");
  assert.equal(metadata.tool_name, "shell");
  assert.equal(metadata.exit_code, null);
  assert.equal(metadata.error, "execution interrupted");
});

test("interruptionRecord omits exit_code for non-shell tools", () => {
  const [, metadata] = interruptionRecord({ id: "call_2", function: { name: "note_find" } }, 1);
  assert.equal(metadata.tool_name, "note_find");
  assert.equal("exit_code" in metadata, false);
});

test("mcpIndex ignores native registry names and incomplete groups", () => {
  const index = mcpIndex([
    null,
    { connection_id: 1, tools: [{ name: "remote", remote_name: "x" }] },
    {
      connection_id: "conn_1",
      tools: [
        { name: "note_find", remote_name: "search" },
        { name: "notion_search", remote_name: "search" },
        { name: "broken" },
      ],
    },
  ]);
  assert.deepEqual(index, { notion_search: ["conn_1", "search"] });
});

test("configSnapshot skips invalid mcp tool entries", () => {
  const snapshot = configSnapshot(AGENT_CONFIG, {
    tools: [],
    secrets: [],
    mcp: [
      { connection_id: "conn_1", tools: "nope" },
      { connection_id: "conn_2", tools: [null, { name: "ok", remote_name: "r", schema: { type: "object" } }] },
    ],
  }, "schedule");
  const tools = snapshot.tools as Array<Record<string, unknown>>;
  assert.equal(tools.some((tool) => tool.type === "object"), true);
  const mcp = snapshot.mcp as Array<{ tools: unknown[] }>;
  assert.deepEqual(mcp[0]?.tools, []);
  assert.deepEqual(mcp[1]?.tools, [{ name: "ok", remote_name: "r" }]);
});

test("mcpRedactions skips missing connections and decrypt failures", async () => {
  process.env.SECRETS_MASTER_KEY = HEX_MASTER_KEY;
  const [ciphertext, nonce] = encryptPayload({ access_token: "tok-live" });
  const values = await mcpRedactions(
    {
      async getMcpConnection(connectionId: string) {
        if (connectionId === "missing") {
          return null;
        }
        if (connectionId === "broken") {
          return { ciphertext: Buffer.from("nope"), nonce: Buffer.alloc(12) };
        }
        return { ciphertext, nonce };
      },
    },
    {
      mcp: [
        { connection_id: "missing" },
        { connection_id: "broken" },
        { connection_id: "live" },
        { connection_id: 1 },
      ],
    },
  );
  assert.equal(values.mcp_live_access_token, "tok-live");
  assert.equal("mcp_missing_access_token" in values, false);
  assert.equal("mcp_broken_access_token" in values, false);
});

test("mcpRedactions returns empty when mcp is not a list", async () => {
  assert.deepEqual(await mcpRedactions({ async getMcpConnection() { return null; } }, {}), {});
});
