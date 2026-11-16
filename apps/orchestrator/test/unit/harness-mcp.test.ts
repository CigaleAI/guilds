import assert from "node:assert/strict";
import { test } from "node:test";
import { HarnessMcpRefused, TOOL_CALL_LIMIT_MESSAGE } from "../../src/generation/errors.js";
import {
  bearerToken,
  HarnessMcpServer,
  narrowedTools,
  servedProtocolVersion,
  type HarnessMcpDatabase,
  type HarnessMcpMessage,
} from "../../src/generation/harness-mcp.js";
import type { SubscriptionGeneration } from "../../src/generation/harness-loop.js";
import { ToolCalls, type GenerationTools, type KeptToolRecord, type ToolCallsServices } from "../../src/generation/tool-calls.js";
import type { MessagePayload, ToolCall } from "../../src/db/schema/index.js";
import type { JsonObject } from "../../src/lib/json.js";
import type { FunctionTool } from "../../src/lib/tool-schema.js";
import { schemasFor } from "../../src/toolbox/index.js";
import { AGENT_CONFIG, agentRow, deferred } from "../helpers/generation.js";
import { toolFixture } from "../helpers/toolbox.js";

const OFFERED = ["note_write", "group_post", "report_issue"];

/** A schema of a tool by `name`, as a connection's tool is offered. */
function connectionSchema(name: string): FunctionTool {
  return { type: "function", function: { name, description: `the ${name} tool`, parameters: { type: "object" } } };
}

type Fixture = {
  server: HarnessMcpServer;
  gen: SubscriptionGeneration;
  tools: GenerationTools;
  calls: ToolCall[];
  rows: Array<{ payload: { role: string } }>;
  answers: Array<(call: ToolCall) => Promise<KeptToolRecord>>;
};

/**
 * A server whose generation of run `r_1` of agent `a_1` offers `OFFERED` and the connection tool
 * `github_get_issue`, with `maxToolCalls` calls; each call is answered by the next of `answers`,
 * or with its name.
 */
function fixture(maxToolCalls = 5): Fixture {
  const agent = agentRow({ id: "a_1", org_id: "o_1", guild_id: "g_1", config: { ...AGENT_CONFIG, model: null, harness: "claude-code" } });
  const schemas = [...schemasFor(OFFERED), connectionSchema("github_get_issue")];
  const gen = {
    runId: "r_1",
    generation: 1,
    log: { run_id: "r_1" },
    run: { id: "r_1", kind: "direct" },
    agent,
    source: "subscription",
    snapshot: { tools: schemas },
  } as unknown as SubscriptionGeneration;
  const tools = {
    run: { offered_tools: new Set([...OFFERED, "github_get_issue"]), dynamic_tools: {} },
    hooks: {},
    schemas,
    secrets: {},
    connections: new Map([["github_get_issue", ["conn_1", "get_issue"]]]),
    maxToolCalls,
  } as unknown as GenerationTools;
  const rows: Fixture["rows"] = [];
  const calls: ToolCall[] = [];
  const answers: Fixture["answers"] = [];
  const db = {
    getAgent: async () => agent,
    listBindingsCovering: async () => [],
    listMessages: async () => rows,
  } as unknown as HarnessMcpDatabase;
  const toolCalls = {
    executeHarnessCall: async (_turn: unknown, _tools: GenerationTools, call: ToolCall): Promise<KeptToolRecord> => {
      calls.push(call);
      rows.push({ payload: { role: "assistant" } }, { payload: { role: "tool" } });
      const answer = answers.shift();
      if (answer) {
        return answer(call);
      }
      return [
        { role: "tool", tool_call_id: call.id, content: `ran ${call.function.name}` },
        { tool_name: call.function.name, tool_call_id: call.id, duration_ms: 1, output_filter: "identity", truncated: false, original_bytes: 1, stored_bytes: 1, error: null, remaining_tool_calls: 1 },
      ];
    },
  } as unknown as ToolCalls;
  const server = new HarnessMcpServer({ db, toolCalls }, "http://172.17.0.1:8090");
  return { server, gen, tools, calls, rows, answers };
}

function request(method: string, params?: Record<string, unknown>, id: string | number = 1): HarnessMcpMessage {
  return params ? { jsonrpc: "2.0", id, method, params: params as JsonObject } : { jsonrpc: "2.0", id, method };
}

test("a grant's token is 256 random bits, and its URL names the agent's path under the base", () => {
  const { server, gen, tools } = fixture();
  const first = server.open(gen, tools);
  const second = server.open(gen, tools);
  assert.equal(Buffer.from(first.access.token, "base64url").length, 32);
  assert.match(first.access.token, /^[A-Za-z0-9_-]{43}$/);
  assert.notEqual(first.access.token, second.access.token);
  assert.equal(first.access.url, "http://172.17.0.1:8090/mcp/a_1");
  assert.ok(!first.grant.digest.equals(Buffer.from(first.access.token)), "the token is kept as its digest");
});

test("a grant's tools redact its token from the run's rows and results", () => {
  const { server, gen, tools } = fixture();
  const { grant, access } = server.open(gen, tools);
  assert.equal(grant.tools.secrets.HARNESS_MCP_TOKEN, access.token);
  assert.equal(grant.tools.run.secrets.HARNESS_MCP_TOKEN, access.token);
  assert.equal(tools.secrets.HARNESS_MCP_TOKEN, undefined, "the generation's own tools are left as they are");
});

test("a request with the generation's token is answered", async () => {
  const { server, gen, tools } = fixture();
  const { access } = server.open(gen, tools);
  const reply = await server.answer("a_1", `Bearer ${access.token}`, request("ping"));
  assert.deepEqual(reply, { jsonrpc: "2.0", id: 1, result: {} });
});

test("a request without a token, with another token, at another agent's path, or after the grant closed is refused alike", async () => {
  const { server, gen, tools } = fixture();
  const { grant, access } = server.open(gen, tools);
  const refused = (agentId: string, authorization: string | undefined) =>
    assert.rejects(server.answer(agentId, authorization, request("ping")), HarnessMcpRefused);
  await refused("a_1", undefined);
  await refused("a_1", "");
  await refused("a_1", access.token);
  await refused("a_1", `Basic ${access.token}`);
  await refused("a_1", `Bearer ${"x".repeat(43)}`);
  await refused("a_1", `Bearer ${access.token}x`);
  await refused("a_2", `Bearer ${access.token}`);
  await server.close(grant);
  await refused("a_1", `Bearer ${access.token}`);
});

test("opening a grant for an agent revokes the agent's earlier one", async () => {
  const { server, gen, tools } = fixture();
  const first = server.open(gen, tools);
  const second = server.open(gen, tools);
  await assert.rejects(server.answer("a_1", `Bearer ${first.access.token}`, request("ping")), HarnessMcpRefused);
  assert.ok(await server.answer("a_1", `Bearer ${second.access.token}`, request("ping")));
  await server.close(first.grant);
  assert.ok(await server.answer("a_1", `Bearer ${second.access.token}`, request("ping")), "closing a revoked grant leaves the new one");
});

test("a bearer header reads its token; anything else reads none", () => {
  assert.equal(bearerToken("Bearer abc_-1"), "abc_-1");
  assert.equal(bearerToken("bearer abc"), "abc");
  assert.equal(bearerToken("Bearer a b"), null);
  assert.equal(bearerToken("Bearer "), null);
  assert.equal(bearerToken(undefined), null);
});

test("initialize answers the client's protocol version when the server speaks it, else its latest", async () => {
  const { server, gen, tools } = fixture();
  const auth = `Bearer ${server.open(gen, tools).access.token}`;
  const reply = await server.answer("a_1", auth, request("initialize", { protocolVersion: "2025-06-18", capabilities: {} }));
  assert.deepEqual(reply, {
    jsonrpc: "2.0",
    id: 1,
    result: { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "guilds", version: "1.0.0" } },
  });
  assert.equal(servedProtocolVersion("2026-07-28"), "2025-11-25");
  assert.equal(servedProtocolVersion(undefined), "2025-11-25");
  assert.equal(servedProtocolVersion("2025-03-26"), "2025-03-26");
});

test("a notification gets no response, and a method the server does not serve is not found", async () => {
  const { server, gen, tools } = fixture();
  const auth = `Bearer ${server.open(gen, tools).access.token}`;
  assert.equal(await server.answer("a_1", auth, { jsonrpc: "2.0", method: "notifications/initialized" }), null);
  assert.deepEqual(await server.answer("a_1", auth, request("server/discover", {}, "probe")), {
    jsonrpc: "2.0",
    id: "probe",
    error: { code: -32601, message: "method server/discover not found" },
  });
});

test("tools/list lists the run's tools by their own names, descriptions and input schemas", async () => {
  const { server, gen, tools } = fixture();
  const auth = `Bearer ${server.open(gen, tools).access.token}`;
  const reply = await server.answer("a_1", auth, request("tools/list"));
  assert.ok(reply && "result" in reply);
  const listed = (reply.result as { tools: Array<{ name: string; description: string; inputSchema: unknown }> }).tools;
  assert.deepEqual(listed.map((tool) => tool.name), [...OFFERED, "github_get_issue"]);
  const [noteWrite] = schemasFor(["note_write"]);
  assert.deepEqual(listed[0], {
    name: "note_write",
    description: noteWrite!.function.description,
    inputSchema: noteWrite!.function.parameters,
  });
});

test("the live narrowing drops a tool the generation offered once the agent's bindings no longer grant it", () => {
  const { tools } = fixture();
  const narrowed = narrowedTools(tools, new Set(["note_write", "github_get_issue", "shell"]));
  assert.deepEqual([...(narrowed.run.offered_tools ?? [])], ["note_write", "github_get_issue"], "never one the generation did not offer");
  assert.deepEqual(narrowed.schemas.map((tool) => tool.function.name), ["note_write", "github_get_issue"]);
  assert.deepEqual([...narrowed.connections.keys()], ["github_get_issue"]);
  assert.deepEqual(narrowed.run.dynamic_tools, {}, "a script's own tool follows script_run");
});

test("a call runs as the run's tool call with the arguments the harness sent, and answers its result", async () => {
  const { server, gen, tools, calls } = fixture();
  const auth = `Bearer ${server.open(gen, tools).access.token}`;
  const reply = await server.answer("a_1", auth, request("tools/call", { name: "note_write", arguments: { path: "a.md", content: "hi" } }));
  assert.deepEqual(reply, { jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: "ran note_write" }], isError: false } });
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.function.name, "note_write");
  assert.deepEqual(JSON.parse(calls[0]!.function.arguments), { path: "a.md", content: "hi" });
  assert.match(calls[0]!.id, /^mcp_/);
});

test("a call of a tool the run does not offer, or without a name, is refused as a protocol error and runs nothing", async () => {
  const { server, gen, tools, calls } = fixture();
  const auth = `Bearer ${server.open(gen, tools).access.token}`;
  assert.deepEqual(await server.answer("a_1", auth, request("tools/call", { name: "shell", arguments: { command: "id" } })), {
    jsonrpc: "2.0",
    id: 1,
    error: { code: -32602, message: "unknown tool shell" },
  });
  assert.deepEqual(await server.answer("a_1", auth, request("tools/call", { arguments: {} })), {
    jsonrpc: "2.0",
    id: 1,
    error: { code: -32602, message: "tools/call takes a tool name and its arguments" },
  });
  assert.equal(calls.length, 0);
});

test("a failed call answers its result as an error", async () => {
  const { server, gen, tools, answers } = fixture();
  const auth = `Bearer ${server.open(gen, tools).access.token}`;
  answers.push(async (call) => [
    { role: "tool", tool_call_id: call.id, content: "ERROR: note not found" },
    { tool_name: "note_write", tool_call_id: call.id, duration_ms: 1, output_filter: "identity", truncated: false, original_bytes: 1, stored_bytes: 1, error: "note not found", remaining_tool_calls: 1 },
  ]);
  const reply = await server.answer("a_1", auth, request("tools/call", { name: "note_write", arguments: {} }));
  assert.deepEqual(reply, { jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: "ERROR: note not found" }], isError: true } });
});

test("a call at the run's tool-call limit is refused with the limit message and asks the turn to stop", async () => {
  const { server, gen, tools, calls, rows } = fixture(2);
  const { grant, access } = server.open(gen, tools);
  const auth = `Bearer ${access.token}`;
  rows.push({ payload: { role: "tool" } });
  await server.answer("a_1", auth, request("tools/call", { name: "note_write", arguments: {} }));
  assert.equal(grant.stop, null, "the call that leaves none is answered");
  const refused = await server.answer("a_1", auth, request("tools/call", { name: "group_post", arguments: {} }));
  assert.deepEqual(refused, { jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: TOOL_CALL_LIMIT_MESSAGE }], isError: true } });
  assert.deepEqual(grant.stop, { kind: "max_tool_calls" });
  assert.equal(calls.length, 1, "the refused call runs nothing");
});

test("a call that files a blocking issue asks the turn to stop, and a later call is refused", async () => {
  const { server, gen, tools, calls, answers } = fixture();
  const { grant, access } = server.open(gen, tools);
  const auth = `Bearer ${access.token}`;
  answers.push(async (call) => [
    { role: "tool", tool_call_id: call.id, content: "filed issue iss_1" },
    { tool_name: "report_issue", tool_call_id: call.id, duration_ms: 1, output_filter: "identity", truncated: false, original_bytes: 1, stored_bytes: 1, error: null, blocking_issue_id: "iss_1", remaining_tool_calls: 3 },
  ]);
  await server.answer("a_1", auth, request("tools/call", { name: "report_issue", arguments: { blocking: true } }));
  assert.deepEqual(grant.stop, { kind: "blocked", issueId: "iss_1" });
  const later = await server.answer("a_1", auth, request("tools/call", { name: "note_write", arguments: {} }));
  assert.ok(later && "result" in later);
  assert.match(JSON.stringify(later.result), /blocking issue iss_1/);
  assert.equal(calls.length, 1);
});

test("a generation's calls run one at a time, in arrival order", async () => {
  const { server, gen, tools, calls, answers } = fixture();
  const auth = `Bearer ${server.open(gen, tools).access.token}`;
  const first = deferred<KeptToolRecord>();
  answers.push(() => first.promise);
  const one = server.answer("a_1", auth, request("tools/call", { name: "note_write", arguments: { n: 1 } }, 1));
  const two = server.answer("a_1", auth, request("tools/call", { name: "group_post", arguments: { n: 2 } }, 2));
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(calls.map((call) => call.function.name), ["note_write"], "the second waits for the first");
  first.resolve([
    { role: "tool", tool_call_id: "x", content: "one" },
    { tool_name: "note_write", tool_call_id: "x", duration_ms: 1, output_filter: "identity", truncated: false, original_bytes: 1, stored_bytes: 1, error: null, remaining_tool_calls: 1 },
  ]);
  await Promise.all([one, two]);
  assert.deepEqual(calls.map((call) => call.function.name), ["note_write", "group_post"]);
});

test("closing a grant waits for its running call, and refuses the call waiting behind it", async () => {
  const { server, gen, tools, calls, answers } = fixture();
  const { grant, access } = server.open(gen, tools);
  const auth = `Bearer ${access.token}`;
  const running = deferred<KeptToolRecord>();
  answers.push(() => running.promise);
  const one = server.answer("a_1", auth, request("tools/call", { name: "note_write", arguments: {} }, 1));
  const two = server.answer("a_1", auth, request("tools/call", { name: "group_post", arguments: {} }, 2));
  await new Promise((resolve) => setTimeout(resolve, 20));
  let closed = false;
  const closing = server.close(grant).then(() => {
    closed = true;
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(closed, false, "the running call is waited for");
  running.resolve([
    { role: "tool", tool_call_id: "x", content: "one" },
    { tool_name: "note_write", tool_call_id: "x", duration_ms: 1, output_filter: "identity", truncated: false, original_bytes: 1, stored_bytes: 1, error: null, remaining_tool_calls: 1 },
  ]);
  await closing;
  assert.ok(await one);
  await assert.rejects(two, HarnessMcpRefused);
  assert.equal(calls.length, 1);
});

test("a request after the agent is gone is refused", async () => {
  const { server, gen, tools } = fixture();
  const auth = `Bearer ${server.open(gen, tools).access.token}`;
  const gone = new HarnessMcpServer(
    {
      db: { getAgent: async () => null, listBindingsCovering: async () => [], listMessages: async () => [] } as unknown as HarnessMcpDatabase,
      toolCalls: {} as ToolCalls,
    },
    "http://x",
  );
  const { access } = gone.open(gen, tools);
  await assert.rejects(gone.answer("a_1", `Bearer ${access.token}`, request("tools/list")), HarnessMcpRefused);
  assert.ok(await server.answer("a_1", auth, request("tools/list")));
});

/** The tool calls of a run whose history is `rows`, kept by an event bus that records each row; `getAgent` reads the call's owner. */
function harnessToolCalls(getAgent: () => Promise<unknown>) {
  const kept: Array<{ payload: MessagePayload; metadata: Record<string, unknown> }> = [];
  const toolCalls = new ToolCalls({
    db: {
      getAgent,
      getRun: async () => null,
      listMessages: async () => kept.map((row, index) => ({ seq: index + 1, ...row })),
    },
    events: {
      commitMessage: async (_runId: string, payload: MessagePayload, metadata: Record<string, unknown>) => {
        kept.push({ payload, metadata });
        return { seq: kept.length };
      },
    },
    tools: {},
  } as unknown as ToolCallsServices);
  const ctx = toolFixture({ run_id: "r_1", agent_id: "a_1", guild_id: "g_1", sandbox: null, secrets: { TOKEN: "tok-123" }, offered_tools: new Set(["report_issue"]) });
  const tools = { run: ctx.run, hooks: ctx.hooks, schemas: [], secrets: { TOKEN: "tok-123" }, connections: new Map(), maxToolCalls: 10 } as unknown as GenerationTools;
  return { toolCalls, tools, kept };
}

test("a harness's call is kept as an assistant row holding it, redacted, then its result with the budget it leaves", async () => {
  const { toolCalls, tools, kept } = harnessToolCalls(async () => null);
  const call: ToolCall = { id: "mcp_1", type: "function", function: { name: "shell", arguments: '{"command":"echo tok-123"}' } };
  const [payload, metadata] = await toolCalls.executeHarnessCall({ runId: "r_1", generation: 2, log: { run_id: "r_1" } }, tools, call);
  assert.deepEqual(kept.map((row) => row.payload.role), ["assistant", "tool"]);
  assert.deepEqual(kept[0], {
    payload: { role: "assistant", content: "", tool_calls: [{ id: "mcp_1", type: "function", function: { name: "shell", arguments: '{"command":"echo [REDACTED:TOKEN]"}' } }] },
    metadata: { generation: 2 },
  });
  assert.equal(payload.content.split("\n")[0], "ERROR: tool shell is not offered this run", "the offer gate applies");
  assert.match(payload.content, /remaining_tool_calls: 9$/);
  assert.equal(metadata.remaining_tool_calls, 9);
  assert.equal(kept[1]?.metadata.generation, 2);
  assert.equal(kept[1]?.metadata.from_harness, undefined, "the run's own tool row");
});

test("a harness's call whose result could not be kept gets the interrupted result before the failure is thrown", async () => {
  const { toolCalls, tools, kept } = harnessToolCalls(async () => {
    throw new Error("database gone");
  });
  const call: ToolCall = { id: "mcp_2", type: "function", function: { name: "report_issue", arguments: "{}" } };
  await assert.rejects(toolCalls.executeHarnessCall({ runId: "r_1", generation: 1, log: { run_id: "r_1" } }, tools, call), /database gone/);
  assert.deepEqual(kept.map((row) => row.payload.role), ["assistant", "tool"]);
  assert.match(String(kept[1]?.payload.content), /^ERROR: execution interrupted/);
  assert.equal(kept[1]?.metadata.tool_call_id, "mcp_2");
});
