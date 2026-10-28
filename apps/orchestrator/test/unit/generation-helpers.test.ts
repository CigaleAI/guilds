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
import { AGENT_CONFIG, runSnapshot, toolCall } from "../helpers/generation.js";

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
        content: "",
        tool_calls: [toolCall("", "note_get"), toolCall("call_b", "note_write"), toolCall("call_a", "note_find")],
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
        content: "",
        tool_calls: [toolCall("call_1", "note_find")],
      },
      metadata: { generation: 1 },
    },
    { payload: { role: "tool", tool_call_id: "call_other", content: "ok" }, metadata: {} },
  ]);
  assert.equal(pending.length, 1);
  assert.equal(pending[0]?.[0].id, "call_1");
});

test("executedToolCalls counts tool role rows only", () => {
  assert.equal(
    executedToolCalls([
      { payload: { role: "assistant", content: "" } },
      { payload: { role: "tool", tool_call_id: "call_1", content: "" } },
      { payload: { role: "tool", tool_call_id: "call_2", content: "" } },
      { payload: { role: "user", content: "" } },
    ]),
    2,
  );
});

test("interruptionRecord writes interrupted content and exit_code for shell", () => {
  const [payload, metadata] = interruptionRecord(toolCall("call_1", "shell"), 4);
  assert.equal(payload.content, INTERRUPTED_CONTENT);
  assert.equal(payload.tool_call_id, "call_1");
  assert.equal(metadata.tool_name, "shell");
  assert.equal(metadata.exit_code, null);
  assert.equal(metadata.error, "execution interrupted");
});

test("interruptionRecord omits exit_code for non-shell tools", () => {
  const [, metadata] = interruptionRecord(toolCall("call_2", "note_find"), 1);
  assert.equal(metadata.tool_name, "note_find");
  assert.equal("exit_code" in metadata, false);
});

test("mcpIndex maps each connection tool to its connection and remote name, never a native tool", () => {
  const index = mcpIndex([
    {
      connection_id: "conn_1",
      server_id: "srv_notion",
      slug: "notion",
      tools: [
        { name: "note_find", remote_name: "search" },
        { name: "notion_search", remote_name: "search" },
      ],
    },
  ]);
  assert.deepEqual(index, { notion_search: ["conn_1", "search"] });
});

test("configSnapshot offers each connection tool's schema and keeps the connection's tools by name", () => {
  const snapshot = configSnapshot(AGENT_CONFIG, {
    tools: [],
    secrets: [],
    mcp: [
      {
        connection_id: "conn_1",
        server_id: "srv_notion",
        slug: "notion",
        tools: [{ name: "ok", remote_name: "r", schema: { type: "object" } }],
      },
    ],
  }, "schedule");
  assert.equal(snapshot.tools.some((tool) => tool.type === "object"), true);
  assert.deepEqual(snapshot.mcp[0]?.tools, [{ name: "ok", remote_name: "r" }]);
});

test("mcpRedactions skips missing connections and decrypt failures", async () => {
  process.env.SECRETS_MASTER_KEY = HEX_MASTER_KEY;
  const [ciphertext, nonce] = encryptPayload({ access_token: "tok-live" });
  const connection = (id: string) => ({ connection_id: id, server_id: "srv", slug: "srv", tools: [] });
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
    { ...runSnapshot(), mcp: [connection("missing"), connection("broken"), connection("live")] },
  );
  assert.equal(values.mcp_live_access_token, "tok-live");
  assert.equal("mcp_missing_access_token" in values, false);
  assert.equal("mcp_broken_access_token" in values, false);
});

