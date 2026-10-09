import assert from "node:assert/strict";
import { PLATFORM_SEED_TOOLS } from "../../src/access/runtime.js";
import { existsSync, mkdirSync, readFileSync as _readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { after, describe, test } from "node:test";
import { DeliveryBusyError } from "../../src/groupchat/index.js";
import { CONTEXT_HISTORY_LIMIT } from "../../src/groupchat/history.js";
import { operatorActor } from "../../src/artifacts/index.js";
import * as generationMod from "../../src/generation/index.js";
import { PolicyError } from "../../src/policy/index.js";
import {
  ConflictError,
  pendingToolCalls,
  RunRequestError,
  withRemainingToolCalls,
} from "../../src/generation/index.js";
import { LLMError } from "../../src/llm/index.js";
import { sleep } from "../../src/lib/event.js";
import { NotesStore } from "../../src/notes/store.js";
import { nextRunAt } from "../../src/schedules/cron.js";
import { NOTE_TOOLS } from "../../src/db/seed/catalog.js";
import { schemasFor } from "../../src/toolbox/index.js";
import { SCRIPT_TOOLS } from "../../src/toolbox/script.js";
import { SCRIPT_ARGS_ENV, launcherCommand } from "../../src/scripts/materialise.js";
import { createGroupRouter, createTypeSafeClient } from "../../src/typesafe/index.js";
import { HEX_MASTER_KEY, tempDir } from "../helpers/env.js";
import { templatesRoot } from "../helpers/fixtures.js";
import {
  abortableHang,
  AGENT_CONFIG,
  completionReply,
  deferred,
  FakeCommands,
  FakeDB,
  FakeSandboxes,
  fakeStream,
  guildDb,
  guildNotes,
  hangForever,
  liveSecret,
  makeLoop,
  parsedState,
  RecordingDB as _RecordingDB,
  seededLoop,
} from "../helpers/generation.js";
import { limitedPolicy } from "../helpers/policy.js";

const live = generationMod.generationLive;
const originalStream = live.streamCompletion;
const originalCount = live.countInputTokens;
const scriptOperator = operatorActor({
  orgId: "org_home",
  actorId: "user_1",
  actorName: "test operator",
  guildId: "g_1",
  agentId: "a_1",
});
const originalGrace = live.cancelGraceMs;
const originalShutdown = live.shutdownTimeoutMs;

after(() => {
  live.streamCompletion = originalStream;
  live.countInputTokens = originalCount;
  live.cancelGraceMs = originalGrace;
  live.shutdownTimeoutMs = originalShutdown;
});

function platformBindings(): Array<Record<string, unknown>> {
  return PLATFORM_SEED_TOOLS.map((name) => ({
    id: `bind_${name}`,
    catalog_kind: "native_tool",
    catalog_id: name,
    scope: "platform",
    scope_id: null,
    enabled: true,
    connection_id: null,
  }));
}

function restoreBindings(): void {
  live.streamCompletion = originalStream;
  live.countInputTokens = originalCount;
  live.cancelGraceMs = originalGrace;
  live.shutdownTimeoutMs = originalShutdown;
}

function withoutWorkspaceMeasure(commands: unknown): string[] {
  return (commands as string[]).filter((command) => !command.includes("guilds-code"));
}

function workspaceMeasureCount(commands: unknown): number {
  return (commands as string[]).filter((command) => command.includes("guilds-code")).length;
}

async function waitTask(
  loop: generationMod.GenerationLoop,
  runId: string,
  timeoutMs = 2000,
): Promise<void> {
  const task = loop._tasks.get(runId);
  if (!task) {
    return;
  }
  await Promise.race([
    task,
    sleep(timeoutMs).then(() => {
      throw new Error(`timed out waiting for ${runId}`);
    }),
  ]);
}

describe("generation", { concurrency: 1 }, () => {
  test("sequential_tool_calls_are_stored_and_replayed", async () => {
    restoreBindings();
    const snapshot = {
      model: "openrouter/openai/gpt-4o-mini",
      temperature: 0,
      max_tokens: 32,
      max_steps: 30,
      tools: [{ type: "function", function: { name: "script_run" } }],
      secrets: [],
    };
    const db = new FakeDB(snapshot);
    const sandboxes = new FakeSandboxes();
    const tmp = tempDir("guilds-gen-");
    const loop = makeLoop(db, {}, tmp, sandboxes);
    await loop.scripts.create(scriptOperator, "a_1", "one", "first", "print(1)");
    await loop.scripts.create(scriptOperator, "a_1", "two", "second", "print(2)");
    const calls = [
      { id: "call_1", function: { name: "script_run", arguments: '{"name":"one"}' } },
      { id: "call_2", function: { name: "script_run", arguments: '{"name":"two"}' } },
    ];
    live.streamCompletion = fakeStream(db, calls);
    await loop._generate("r_1", 1);
    assert.deepEqual(sandboxes.created, [["a_1", {}]]);
    assert.deepEqual(sandboxes.browser_flags, [false]);
    assert.ok(existsSync(path.join(tmp, "a_1", "scripts")));
    assert.equal(existsSync(path.join(tmp, "a_1", ".browser")), false, "a lite run has no browser profile");
    assert.deepEqual(withoutWorkspaceMeasure(sandboxes.commands.commands), [
      launcherCommand("one"),
      launcherCommand("two"),
    ]);
    assert.equal(workspaceMeasureCount(sandboxes.commands.commands), 1);
    const toolRows = db.messages.filter(
      (row) => (row.payload as Record<string, unknown>).role === "tool",
    );
    const toolPayloads = toolRows.map((row) => row.payload as Record<string, unknown>);
    assert.deepEqual(
      toolPayloads.map((item) => item.content),
      [
        withRemainingToolCalls(`ok:${launcherCommand("one")}`, 49),
        withRemainingToolCalls(`ok:${launcherCommand("two")}`, 48),
      ],
    );
    assert.deepEqual(
      toolRows.map((row) => (row.metadata as Record<string, unknown>).remaining_tool_calls),
      [49, 48],
    );
    assert.deepEqual(
      toolPayloads.map((item) => item.tool_call_id),
      ["call_1", "call_2"],
    );
    assert.equal(db.llm_histories.length, 2);
    assert.deepEqual(db.llm_histories[1]?.slice(-2), toolPayloads);
    assert.equal(db.llm_histories[1]?.at(-2), toolPayloads[0]);
    assert.deepEqual(db.run.errors, []);
    restoreBindings();
  });

  test("tool_call_limit_completes_the_run", async () => {
    restoreBindings();
    const snapshot = {
      model: "openrouter/openai/gpt-4o-mini",
      temperature: 0,
      max_tokens: 32,
      max_steps: 30,
      max_tool_calls: 1,
      max_input_tokens: 100000,
      tools: [{ type: "function", function: { name: "script_run" } }],
      secrets: [],
    };
    const db = new FakeDB(snapshot);
    const tmp = tempDir("guilds-gen-");
    const loop = makeLoop(db, {}, tmp, new FakeSandboxes());
    await loop.scripts.create(scriptOperator, "a_1", "one", "first", "print(1)");
    const call = {
      id: "call_1",
      function: { name: "script_run", arguments: '{"name":"one"}' },
    };
    live.streamCompletion = async function* keepCalling(options: {
      messages: Array<Record<string, unknown>>;
    }) {
      db.llm_histories.push([...options.messages]);
      yield [
        "done" as const,
        {
          payload: { role: "assistant", content: null, tool_calls: [call] },
          metadata: {
            usage: { input_tokens: 1, output_tokens: 1, cache_read_tokens: 0 },
            latency_ms: 1,
            finish_reason: "tool_calls",
            model: "test",
            response_id: "c1",
            provider_request_id: null,
            cost_usd: 0.0,
          },
        },
      ];
    };
    await loop._generate("r_1", 1);
    const toolPayloads = db.messages
      .filter((row) => (row.payload as Record<string, unknown>).role === "tool")
      .map((row) => row.payload as Record<string, unknown>);
    assert.equal(toolPayloads.length, 1);
    assert.ok(String(toolPayloads[0]?.content).endsWith("remaining_tool_calls: 0"));
    assert.equal(db.llm_histories.length, 1);
    assert.equal(db.run.status, "completed");
    const errors = db.run.errors as Array<Record<string, unknown>>;
    assert.equal(errors[errors.length - 1]?.operation, "generation.max_tool_calls");
    assert.match(String(errors[errors.length - 1]?.message), /Start a new run/);
    restoreBindings();
  });

  test("input_token_limit_completes_the_run", async () => {
    restoreBindings();
    const snapshot = {
      model: "openrouter/openai/gpt-4o-mini",
      temperature: 0,
      max_tokens: 32,
      max_steps: 30,
      max_tool_calls: 50,
      max_input_tokens: 8,
      tools: [],
      secrets: [],
    };
    const db = new FakeDB(snapshot);
    const loop = makeLoop(db, {}, tempDir("guilds-gen-"), new FakeSandboxes());
    live.countInputTokens = () => 9;
    live.streamCompletion = async function* shouldNotRun() {
      throw new Error("model should not be called");
      yield ["done", completionReply("nope")];
    };
    await loop._generate("r_1", 1);
    assert.ok(db.messages.every((row) => (row.payload as Record<string, unknown>).role !== "assistant"));
    assert.equal(db.run.status, "completed");
    const errors = db.run.errors as Array<Record<string, unknown>>;
    assert.equal(errors[errors.length - 1]?.operation, "generation.max_input_tokens");
    assert.match(String(errors[errors.length - 1]?.message), /Start a new run/);
    restoreBindings();
  });

  test("projects large previous-generation tool results before the model call", async () => {
    restoreBindings();
    const large = "x".repeat(3000);
    const snapshot = {
      model: "openrouter/openai/gpt-4o-mini",
      temperature: 0,
      max_tokens: 32,
      max_steps: 30,
      max_tool_calls: 50,
      max_input_tokens: 100000,
      keep_tool_result_generations: 1,
      tools: [],
      secrets: [],
    };
    const db = new FakeDB(snapshot);
    db.messages.push(
      {
        id: 3,
        seq: 2,
        payload: {
          role: "assistant",
          content: null,
          tool_calls: [{ id: "c1", type: "function", function: { name: "file_read", arguments: "{}" } }],
        },
        metadata: { generation: 1 },
        created_at: new Date(),
      },
      {
        id: 4,
        seq: 3,
        payload: { role: "tool", tool_call_id: "c1", content: large },
        metadata: { generation: 1, tool_name: "file_read", path: "repos/shop/src/a.ts" },
        created_at: new Date(),
      },
      {
        id: 5,
        seq: 4,
        payload: { role: "user", content: "continue" },
        metadata: { generation: 2, source: "ui" },
        created_at: new Date(),
      },
    );
    const seen: Array<Record<string, unknown>> = [];
    live.streamCompletion = async function* capture(options: { messages: Array<Record<string, unknown>> }) {
      seen.push(...options.messages);
      yield ["done", completionReply("ok")];
    };
    const loop = makeLoop(db, {}, tempDir("guilds-gen-"), new FakeSandboxes());
    await loop._generate("r_1", 2);
    const tool = seen.find((item) => item.role === "tool");
    assert.match(String(tool?.content), /"stub":true/);
    assert.match(String(tool?.content), /file_read/);
    assert.match(String(tool?.content), /repos\/shop\/src\/a\.ts/);
    assert.doesNotMatch(String(tool?.content), /xxx/);
    const stored = db.messages.find((row) => row.seq === 3);
    assert.equal((stored?.payload as Record<string, unknown>).content, large);
    restoreBindings();
  });

  test("add_message_rejects_ended_run", async () => {
    const db = new FakeDB({
      model: "openrouter/openai/gpt-4o-mini",
      temperature: 0,
      max_tokens: 32,
      max_steps: 30,
      max_tool_calls: 50,
      max_input_tokens: 100000,
      tools: [],
      secrets: [],
    });
    db.run.status = "completed";
    const loop = makeLoop(db, {}, tempDir("guilds-gen-"), new FakeSandboxes());
    await assert.rejects(() => loop.add_message("r_1", "hello"), (error: unknown) => {
      assert.ok(error instanceof RunRequestError);
      assert.match(error.detail, /resume it to continue/);
      assert.equal(error.status, 409);
      return true;
    });
  });

  test("resume_reopens_a_completed_run", async () => {
    const db = new FakeDB({
      model: "openrouter/openai/gpt-4o-mini",
      temperature: 0,
      max_tokens: 32,
      max_steps: 30,
      max_tool_calls: 50,
      max_input_tokens: 100000,
      tools: [],
      secrets: [],
    });
    db.run.status = "completed";
    db.run.kind = "group";
    const loop = makeLoop(db, {}, tempDir("guilds-gen-"), new FakeSandboxes());
    const view = await loop.resume_run("r_1");
    assert.equal(view.status, "active");
    assert.equal(db.run.status, "active");
    assert.equal(typeof (db.run.metadata as Record<string, unknown>).resumed_at, "string");
    loop._spawn = () => undefined;
    await loop.add_message("r_1", "keep going");
    const last = db.messages[db.messages.length - 1];
    assert.equal((last?.payload as Record<string, unknown>).content, "keep going");
  });

  test("resume_rejects_a_capped_run", async () => {
    const db = new FakeDB({
      model: "openrouter/openai/gpt-4o-mini",
      temperature: 0,
      max_tokens: 32,
      max_steps: 30,
      max_tool_calls: 50,
      max_input_tokens: 100000,
      tools: [],
      secrets: [],
    });
    db.run.status = "completed";
    db.run.errors = [{ operation: "generation.max_tool_calls", message: "Tool call limit reached. Start a new run to continue." }];
    const loop = makeLoop(db, {}, tempDir("guilds-gen-"), new FakeSandboxes());
    await assert.rejects(() => loop.resume_run("r_1"), (error: unknown) => {
      assert.ok(error instanceof RunRequestError);
      assert.match(error.detail, /tool, token, or chain cap/);
      assert.equal(error.status, 409);
      return true;
    });
    assert.equal(db.run.status, "completed");
  });

  test("resumed_schedule_run_stays_active", async () => {
    restoreBindings();
    const snapshot = {
      model: "openrouter/openai/gpt-4o-mini",
      temperature: 0,
      max_tokens: 32,
      max_steps: 30,
      max_tool_calls: 50,
      max_input_tokens: 100000,
      tools: [],
      secrets: [],
    };
    const db = new FakeDB(snapshot);
    db.run.kind = "schedule";
    db.run.metadata = { resumed_at: "2026-01-01T00:00:00.000Z" };
    const loop = makeLoop(db, {}, tempDir("guilds-gen-"), new FakeSandboxes());
    live.streamCompletion = async function* reply() {
      yield ["done", completionReply("ok")];
    };
    await loop._generate("r_1", 1);
    assert.equal(db.run.status, "active");
    restoreBindings();
  });

  test("reconcile_leaves_a_resumed_group_run_active", async () => {
    const db = new FakeDB({});
    db.run.kind = "group";
    db.run.metadata = { resumed_at: "2026-01-01T00:00:00.000Z" };
    db.run.group_chat_through_seq = 4;
    const loop = makeLoop(db, {}, tempDir("guilds-gen-"), new FakeSandboxes());
    await loop.reconcile();
    assert.equal(db.run.status, "active");
    assert.deepEqual(db.run.errors, []);
  });

  test("mcp_tool_call_dispatches_to_pool", async () => {
    restoreBindings();
    const snapshot = {
      model: "openrouter/openai/gpt-4o-mini",
      temperature: 0,
      max_tokens: 32,
      max_steps: 30,
      tools: [{ type: "function", function: { name: "notion_search" } }],
      mcp: [
        {
          connection_id: "conn_u",
          server_id: "mcp_notion",
          slug: "notion",
          tools: [{ name: "notion_search", remote_name: "search" }],
        },
      ],
      secrets: [],
    };
    const db = new FakeDB(snapshot);
    db.mcp_connection = { id: "conn_u", mcp_server_id: "mcp_notion", status: "connected" };
    db.mcp_server = { id: "mcp_notion", slug: "notion" };
    const calls: Array<[string, string, Record<string, unknown>]> = [];
    const pool = {
      async call(
        _db: unknown,
        connection: Record<string, unknown>,
        _server: Record<string, unknown>,
        remoteName: string,
        arguments_: Record<string, unknown>,
      ) {
        calls.push([String(connection.id), remoteName, arguments_]);
        return "page found";
      },
    };
    const loop = makeLoop(db, {}, tempDir("guilds-gen-"), new FakeSandboxes(), { mcp: pool });
    live.streamCompletion = fakeStream(db, [
      { id: "call_1", function: { name: "notion_search", arguments: '{"query":"notes"}' } },
    ]);
    await loop._generate("r_1", 1);
    assert.deepEqual(calls, [["conn_u", "search", { query: "notes" }]]);
    const tool = db.messages
      .filter((row) => (row.payload as Record<string, unknown>).role === "tool")
      .map((row) => row.payload);
    assert.deepEqual(tool, [
      {
        role: "tool",
        tool_call_id: "call_1",
        content: withRemainingToolCalls("page found", 49),
      },
    ]);
    restoreBindings();
  });

  test("mcp_tokens_redact_but_never_reach_sandbox_env", async () => {
    restoreBindings();
    process.env.SECRETS_MASTER_KEY = HEX_MASTER_KEY;
    const { encryptPayload } = await import("../../src/credentials/crypto.js");
    const [ciphertext, nonce] = encryptPayload({
      access_token: "tok-access",
      refresh_token: "tok-refresh",
    });
    const snapshot = {
      model: "openrouter/openai/gpt-4o-mini",
      temperature: 0,
      max_tokens: 32,
      max_steps: 30,
      tools: [{ type: "function", function: { name: "notion_search" } }],
      mcp: [
        {
          connection_id: "conn_u",
          server_id: "mcp_notion",
          slug: "notion",
          tools: [{ name: "notion_search", remote_name: "search" }],
        },
      ],
      secrets: [],
    };
    const db = new FakeDB(snapshot);
    db.mcp_connection = {
      id: "conn_u",
      mcp_server_id: "mcp_notion",
      status: "connected",
      ciphertext,
      nonce,
    };
    db.mcp_server = { id: "mcp_notion", slug: "notion" };
    const pool = {
      async call() {
        return "token is tok-access and tok-refresh";
      },
    };
    const sandboxes = new FakeSandboxes();
    const loop = makeLoop(db, {}, tempDir("guilds-gen-"), sandboxes, { mcp: pool });
    live.streamCompletion = fakeStream(db, [
      { id: "call_1", function: { name: "notion_search", arguments: "{}" } },
    ]);
    await loop._generate("r_1", 1);
    assert.deepEqual(sandboxes.created, [["a_1", {}]]);
    const tool = db.messages
      .filter((row) => (row.payload as Record<string, unknown>).role === "tool")
      .map((row) => row.payload as Record<string, unknown>);
    assert.equal(
      tool[0]?.content,
      withRemainingToolCalls(
        "token is [REDACTED:mcp_conn_u_access_token] and [REDACTED:mcp_conn_u_refresh_token]",
        49,
      ),
    );
    restoreBindings();
  });

  test("agent_lock_serializes_generations", async () => {
    const loop = makeLoop({}, {}, tempDir("guilds-gen-"), {});
    await loop._begin("r_1", "a_1");
    await assert.rejects(() => loop._begin("r_2", "a_1"), (error: unknown) => {
      assert.ok(error instanceof ConflictError);
      assert.match(error.message, /already generating/);
      return true;
    });
    await loop._begin("r_3", "a_2");
    loop._end("r_1");
    await loop._begin("r_2", "a_1");
  });

  test("secret_change_restarts_idle_agent_sandbox", async () => {
    const db = new FakeDB({});
    const sandboxes = new FakeSandboxes();
    sandboxes.secret_users.sec_1 = new Set(["a_1"]);
    const loop = makeLoop(db, {}, tempDir("guilds-gen-"), sandboxes);
    await loop.secretChanged("sec_1");
    assert.deepEqual(sandboxes.destroyed, ["a_1"]);
    assert.ok(!loop._stale_sandboxes.has("a_1"));
    assert.ok(!loop._busy_agents.has("a_1"));
  });

  test("secret_change_restarts_sandbox_after_active_generation", async () => {
    const db = new FakeDB({});
    db.active_secret_agent_ids = ["a_1"];
    const sandboxes = new FakeSandboxes();
    const loop = makeLoop(db, {}, tempDir("guilds-gen-"), sandboxes);
    await loop._begin("r_1", "a_1");
    await loop.secretChanged("sec_1");
    assert.deepEqual(sandboxes.destroyed, []);
    assert.ok(loop._stale_sandboxes.has("a_1"));
    await loop._refresh_stale_sandbox("r_1");
    loop._end("r_1");
    assert.deepEqual(sandboxes.destroyed, ["a_1"]);
    assert.ok(!loop._stale_sandboxes.has("a_1"));
  });

  test("idle_timeout_stops_sandbox", async () => {
    const db = new FakeDB({});
    const sandboxes = new FakeSandboxes();
    const loop = makeLoop(db, {}, tempDir("guilds-gen-"), sandboxes, { idleTimeoutMs: 20 });
    await loop._begin("r_1", "a_1");
    loop._end("r_1");
    await sleep(80);
    assert.deepEqual(sandboxes.destroyed, ["a_1"]);
    assert.ok(!loop._idle_tasks.has("a_1"));
  });

  test("idle_timeout_is_cancelled_by_next_generation", async () => {
    const db = new FakeDB({});
    const sandboxes = new FakeSandboxes();
    const loop = makeLoop(db, {}, tempDir("guilds-gen-"), sandboxes, { idleTimeoutMs: 50 });
    await loop._begin("r_1", "a_1");
    loop._end("r_1");
    await loop._begin("r_2", "a_1");
    await sleep(80);
    assert.deepEqual(sandboxes.destroyed, []);
    loop._end("r_2");
  });

  test("reconcile_starts_idle_timer_for_running_sandboxes", async () => {
    const db = new FakeDB({});
    db.listActiveRuns = async () => [];
    const sandboxes = new FakeSandboxes();
    sandboxes.running.add("a_1");
    const loop = makeLoop(db, {}, tempDir("guilds-gen-"), sandboxes, { idleTimeoutMs: 20 });
    await loop.reconcile();
    await sleep(80);
    assert.deepEqual(sandboxes.destroyed, ["a_1"]);
  });

  test("delete_agent_purges_workspace_and_rows", async () => {
    const tmp = tempDir("guilds-gen-");
    const workspace = path.join(tmp, "a_1");
    mkdirSync(workspace);
    writeFileSync(path.join(workspace, "scratch.txt"), "keep-me-not");
    const deleted: Array<[string, string, string]> = [];
    const notes = {
      async deleteAgent(orgSlug: string, guildName: string, name: string) {
        deleted.push([orgSlug, guildName, name]);
      },
    };
    const purged: string[] = [];
    const db = {
      async getAgent(agentId: string) {
        return agentId === "a_1"
          ? { id: "a_1", name: "researcher", guild_name: "research", org_slug: "acme" }
          : null;
      },
      async purgeAgent(agentId: string) {
        purged.push(agentId);
      },
    };
    const sandboxes = new FakeSandboxes();
    const loop = makeLoop(db, notes, tmp, sandboxes);
    await loop.delete_agent("a_1");
    assert.deepEqual(sandboxes.destroyed, ["a_1"]);
    assert.deepEqual(deleted, [["acme", "research", "researcher"]]);
    assert.deepEqual(purged, ["a_1"]);
    assert.ok(!existsSync(workspace));
  });

  test("delete_agent_conflicts_while_generating", async () => {
    const db = {
      async getAgent(agentId: string) {
        return { id: agentId, name: "researcher", guild_name: "research", org_slug: "acme" };
      },
    };
    const loop = makeLoop(db, {}, tempDir("guilds-gen-"), new FakeSandboxes());
    await loop._begin("r_1", "a_1");
    await assert.rejects(() => loop.delete_agent("a_1"), (error: unknown) => {
      assert.ok(error instanceof RunRequestError);
      assert.match(error.detail, /already generating/);
      assert.equal(error.status, 409);
      return true;
    });
  });

  test("delete_guild_purges_members_and_rows", async () => {
    const tmp = tempDir("guilds-gen-");
    for (const agentId of ["a_1", "a_2"]) {
      const workspace = path.join(tmp, agentId);
      mkdirSync(workspace);
      writeFileSync(path.join(workspace, "scratch.txt"), "keep-me-not");
    }
    const db = guildDb(["a_1", "a_2"]);
    const notes = guildNotes();
    const sandboxes = new FakeSandboxes();
    const loop = makeLoop(db, notes, tmp, sandboxes);
    await loop.delete_guild("guild_1");
    assert.deepEqual(sandboxes.destroyed, ["a_1", "a_2"]);
    assert.deepEqual(notes.deleted, [["acme", "research"]]);
    assert.deepEqual(db.purged, ["guild_1"]);
    assert.ok(!existsSync(path.join(tmp, "a_1")));
    assert.ok(!existsSync(path.join(tmp, "a_2")));
    assert.ok(!loop.deleting_guild("guild_1"));
  });

  test("delete_guild_is_retryable_after_cleanup", async () => {
    const db = guildDb(["a_1"]);
    const notes = guildNotes();
    const loop = makeLoop(db, notes, tempDir("guilds-gen-"), new FakeSandboxes());
    await loop.delete_guild("guild_1");
    await loop.delete_guild("guild_1");
    assert.deepEqual(db.purged, ["guild_1", "guild_1"]);
  });

  test("delete_guild_missing_is_not_found", async () => {
    const loop = makeLoop(guildDb([]), guildNotes(), tempDir("guilds-gen-"), new FakeSandboxes());
    await assert.rejects(() => loop.delete_guild("guild_missing"), (error: unknown) => {
      assert.ok(error instanceof RunRequestError);
      assert.match(error.detail, /not found/);
      assert.equal(error.status, 404);
      return true;
    });
  });

  test("delete_guild_conflicts_while_member_generating", async () => {
    const loop = makeLoop(guildDb(["a_1", "a_2"]), guildNotes(), tempDir("guilds-gen-"), new FakeSandboxes());
    await loop._begin("r_1", "a_2");
    await assert.rejects(() => loop.delete_guild("guild_1"), (error: unknown) => {
      assert.ok(error instanceof RunRequestError);
      assert.match(error.detail, /already generating/);
      assert.equal(error.status, 409);
      return true;
    });
  });

  test("delete_guild_conflicts_while_dispatching", async () => {
    const loop = makeLoop(guildDb(["a_1"]), guildNotes(), tempDir("guilds-gen-"), new FakeSandboxes());
    loop.group_chat._dispatch_tasks.set("guild_1", { promise: hangForever(), done: () => false });
    await assert.rejects(() => loop.delete_guild("guild_1"), (error: unknown) => {
      assert.ok(error instanceof RunRequestError);
      assert.match(error.detail, /delivering/);
      assert.equal(error.status, 409);
      return true;
    });
  });

  test("add_message_rejects_group_runs", async () => {
    const { loop, db } = await seededLoop();
    db.run = {
      id: "r_group",
      agent_id: "a_1",
      status: "active",
      kind: "group",
      archived_at: null,
      config_snapshot: {},
      errors: [],
      created_at: new Date(),
      updated_at: new Date(),
    };
    await assert.rejects(() => loop.add_message("r_group", "hello"), (error: unknown) => {
      assert.ok(error instanceof RunRequestError);
      assert.match(error.detail, /group-triggered/);
      assert.equal(error.status, 409);
      return true;
    });
  });

  test("add_message_rejects_schedule_runs", async () => {
    const { loop, db } = await seededLoop();
    db.run = {
      id: "r_sched",
      agent_id: "a_1",
      status: "active",
      kind: "schedule",
      archived_at: null,
      config_snapshot: {},
      errors: [],
      created_at: new Date(),
      updated_at: new Date(),
    };
    await assert.rejects(() => loop.add_message("r_sched", "hello"), (error: unknown) => {
      assert.ok(error instanceof RunRequestError);
      assert.match(error.detail, /schedule-triggered/);
      assert.equal(error.status, 409);
      return true;
    });
  });

  test("deliver_schedule_run_inserts_wake_message", async () => {
    const { loop, db } = await seededLoop();
    const started: Array<[string, number]> = [];
    loop._spawn = (runId, generation) => {
      started.push([runId, generation]);
    };
    await loop.deliver_schedule_run({
      id: "sch_1",
      agent_id: "a_1",
      cron: "*/30 * * * *",
      instruction: "Check the shared notes.",
    });
    assert.deepEqual(started, [[String(db.create_args?.run_id), 1]]);
    assert.ok(loop.agent_is_busy("a_1"));
    assert.equal(db.run?.kind, "schedule");
    assert.deepEqual(
      db.messages.map((row) => (row.metadata as Record<string, unknown>).source),
      ["system", "schedule"],
    );
    const user = db.messages.filter((row) => (row.payload as Record<string, unknown>).role === "user");
    assert.equal(user.length, 1);
    assert.ok(String((user[0]?.payload as Record<string, unknown>).content).startsWith("Schedule wake-up: "));
    assert.ok(String((user[0]?.payload as Record<string, unknown>).content).includes("Check the shared notes."));
    assert.equal((user[0]?.metadata as Record<string, unknown>).source, "schedule");
    const names = (
      (db.run?.config_snapshot as { tools: Array<{ function: { name: string } }> }).tools ?? []
    ).map((item) => item.function.name);
    assert.ok(names.includes("group_post"));
    assert.ok(names.includes("report_issue"));
    assert.ok(names.includes("script_create"));
    assert.ok(!names.includes("schedule_create_cron"));
    assert.ok(!names.includes("schedule_create_window"));
  });

  test("schedule_delivery_reserves_agent_before_insert_and_releases_on_failure", async () => {
    const { loop, db } = await seededLoop();
    const busyDuringInsert: boolean[] = [];
    db.createScheduleRun = async () => {
      busyDuringInsert.push(loop.agent_is_busy("a_1"));
      throw new Error("insert failed");
    };
    await assert.rejects(
      () =>
        loop.deliver_schedule_run({
          id: "sch_1",
          agent_id: "a_1",
          cron: "*/30 * * * *",
          instruction: "Check the shared notes.",
        }),
      /insert failed/,
    );
    assert.deepEqual(busyDuringInsert, [true]);
    assert.ok(!loop.agent_is_busy("a_1"));
    assert.equal(db.run, null);
  });

  test("schedule_delivery_is_busy_when_agent_taken_during_prompt_load", async () => {
    const { loop, db } = await seededLoop();
    const original = db.listGroupMessages.bind(db);
    db.listGroupMessages = async (...args) => {
      await loop._begin("r_other", "a_1");
      return original(...args);
    };
    await assert.rejects(
      () =>
        loop.deliver_schedule_run({
          id: "sch_1",
          agent_id: "a_1",
          cron: "*/30 * * * *",
          instruction: "Check the shared notes.",
        }),
      (error: unknown) => error instanceof DeliveryBusyError,
    );
    assert.equal(db.run, null);
  });

  test("fire_due_skips_busy_agent_without_advancing", async () => {
    const { loop, db } = await seededLoop();
    db.due_schedules = [{ id: "sch_1", agent_id: "a_1", cron: "*/30 * * * *", instruction: "ping" }];
    loop._busy_agents.add("a_1");
    loop.deliver_schedule_run = async () => {
      throw new Error("should not fire");
    };
    await loop.fire_due_schedules(new Date());
    assert.deepEqual(db.fired, []);
  });

  test("fire_due_advances_after_start", async () => {
    const { loop, db } = await seededLoop();
    const now = new Date("2026-09-12T16:00:00Z");
    db.due_schedules = [{ id: "sch_1", agent_id: "a_1", cron: "*/30 * * * *", instruction: "ping" }];
    loop.deliver_schedule_run = async (row) => {
      db.delivered = String(row.id);
    };
    await loop.fire_due_schedules(now);
    assert.equal(db.delivered, "sch_1");
    assert.equal(db.fired[0]?.id, "sch_1");
    assert.equal((db.fired[0]?.next_run_at as Date).getTime(), nextRunAt(now, "*/30 * * * *").getTime());
  });

  test("delete_guild_blocks_new_runs_while_deleting", async () => {
    const db = guildDb(["a_1"]);
    db.getAgent = async () => ({
      id: "a_1",
      guild_id: "guild_1",
      name: "researcher",
      guild_name: "research",
      org_id: "org_1",
      org_slug: "acme",
      archived_at: null,
      guild_archived_at: null,
      config: {},
    });
    const notes = guildNotes();
    const tmp = tempDir("guilds-gen-");
    const loop = makeLoop(db, notes, tmp, new FakeSandboxes());
    notes.deleteGuild = async () => {
      try {
        await loop.create_run("a_1", null);
      } catch (error) {
        if (error instanceof RunRequestError) {
          notes.rejected = error;
        }
      }
    };
    await loop.delete_guild("guild_1");
    assert.ok(notes.rejected);
    assert.equal(notes.rejected.status, 409);
    assert.match(notes.rejected.detail, /being deleted/);
  });

  test("note_write_enters_history", async () => {
    restoreBindings();
    const tmp = tempDir("guilds-gen-");
    const root = path.join(tmp, "notes");
    mkdirSync(root);
    const notes = new NotesStore(root, templatesRoot(), "notes");
    await notes.createGuild("acme", "research");
    await notes.createAgent("acme", "research", "researcher");
    const snapshot = {
      model: "openrouter/openai/gpt-4o-mini",
      temperature: 0,
      max_tokens: 32,
      max_steps: 30,
      tools: schemasFor(["note_write"]),
      secrets: [],
    };
    const db = new FakeDB(snapshot);
    const calls = [
      {
        id: "call_1",
        function: {
          name: "note_write",
          arguments: '{"level":"agent","key":"slice5.md","content":"from-chat\\n"}',
        },
      },
    ];
    const artifacts = {
      async writeNote(
        actor: { orgId: string; agentId: string | null },
        args: { path: string; key: string },
      ) {
        return {
          display_path: `org/${actor.orgId}/agents/${actor.agentId}/${args.path ? `${args.path}/` : ""}${args.key}`,
        };
      },
      view(row: { display_path: string }) {
        return { display_path: row.display_path };
      },
    };
    const loop = makeLoop(db, notes, path.join(tmp, "workspaces"), new FakeSandboxes(), {
      artifacts: artifacts as never,
    });
    live.streamCompletion = fakeStream(db, calls);
    await loop._generate("r_1", 1);
    const toolPayloads = db.messages
      .filter((row) => (row.payload as Record<string, unknown>).role === "tool")
      .map((row) => row.payload as Record<string, unknown>);
    assert.deepEqual(
      toolPayloads.map((item) => item.content),
      [withRemainingToolCalls("org/org_1/agents/a_1/slice5.md", 49)],
    );
    assert.equal(db.llm_histories[1]?.at(-1), toolPayloads[0]);
    assert.deepEqual(db.run.errors, []);
    restoreBindings();
  });

  test("create_run_without_message_stores_task_as_system_and_stays_idle", async () => {
    const { loop, db } = await seededLoop();
    loop._spawn = () => undefined;
    const result = await loop.create_run("a_1", null);
    assert.ok(db.create_args);
    const system = String(db.create_args.system_content);
    assert.ok(system.includes("You are an agent in a work guild"));
    assert.ok(system.includes("You are researcher. Your id is a_1."));
    const state = parsedState(system);
    assert.match(String(state.utc_now), /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
    assert.match(
      String(state.utc_date),
      /^(Sunday|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday), \d{1,2} (January|February|March|April|May|June|July|August|September|October|November|December) \d{4}$/,
    );
    assert.equal(state.max_tool_calls, 50);
    assert.deepEqual((state.group as { members: unknown }).members, [{ name: "researcher" }]);
    assert.deepEqual((state.group as { history: unknown }).history, []);
    assert.deepEqual(state.readable_levels, ["agent", "guild", "org"]);
    assert.deepEqual(state.writable_levels, ["agent", "guild"]);
    assert.deepEqual(state.collections, []);
    assert.ok(!("shared" in state));
    assert.ok(!("notes" in state));
    assert.ok(!("database" in state));
    assert.deepEqual(state.scripts, []);
    assert.deepEqual(state.environment, []);
    assert.ok(!("database" in state));
    assert.ok(String(db.create_args.task_content).includes("Assist the user and collaborate with the guild members."));
    assert.equal(db.create_args.user_content, null);
    const snapshot = db.run?.config_snapshot as Record<string, unknown>;
    assert.equal(snapshot.browser, false);
    assert.equal(snapshot.database, false);
    assert.equal(snapshot.max_tool_calls, 50);
    assert.equal(snapshot.max_input_tokens, 100000);
    assert.equal(snapshot.keep_tool_result_generations, 1);
    assert.equal(snapshot.projection_policy_version, 1);
    assert.deepEqual(snapshot.mcp, []);
    assert.ok(system.startsWith("<guidelines>"));
    assert.ok(system.includes("<task>"));
    assert.ok(system.includes("<state>"));
    assert.ok(system.includes("<memory>"));
    assert.ok(system.includes("There is no required format"));
    assert.deepEqual(
      db.messages.map((row) => (row.payload as Record<string, unknown>).role),
      ["system"],
    );
    assert.deepEqual(
      db.messages.map((row) => (row.metadata as Record<string, unknown>).source),
      ["system"],
    );
    assert.equal(result.generating, false);
    assert.ok(!loop._busy_agents.has("a_1"));
  });

  test("create_run_offers_artifact_tools_not_database_tools", async () => {
    const { loop, db } = await seededLoop();
    loop._spawn = () => undefined;
    await loop.create_run("a_1", null);
    assert.equal((db.run?.config_snapshot as Record<string, unknown>).database, false);
    const names = (
      (db.run?.config_snapshot as { tools: Array<{ function: { name: string } }> }).tools ?? []
    ).map((item) => item.function.name);
    assert.deepEqual(names, [
      "note_find",
      "note_get",
      "note_write",
      "note_delete",
      "record_search",
      "record_list",
      "record_add",
      "record_update",
      "record_remove",
      "memory_write",
      "script_create",
      "script_list",
      "script_read",
      "script_run",
      "script_delete",
      "schedule_create_cron",
      "schedule_create_window",
      "schedule_list",
      "schedule_pause",
      "schedule_resume",
      "schedule_delete",
      "secret_store",
      "secret_request",
      "group_post",
      "report_issue",
    ]);
    const state = parsedState(String(db.create_args?.system_content));
    assert.deepEqual(state.collections, []);
    assert.ok(!("database" in state));
  });

  test("create_run_omits_group_post_when_binding_is_off", async () => {
    const { loop, db } = await seededLoop();
    loop._spawn = () => undefined;
    db.bindings = [
      {
        id: "bind_off",
        catalog_kind: "native_tool",
        catalog_id: "group_post",
        scope: "agent",
        scope_id: "a_1",
        enabled: false,
        connection_id: null,
      },
    ];
    await loop.create_run("a_1", null);
    const names = (
      (db.run?.config_snapshot as { tools: Array<{ function: { name: string } }> }).tools ?? []
    ).map((item) => item.function.name);
    assert.ok(!names.includes("group_post"));
    assert.ok(names.includes("report_issue"));
  });

  test("create_run_omits_script_tools_when_bindings_are_off", async () => {
    const { loop, db } = await seededLoop();
    loop._spawn = () => undefined;
    await loop.scripts.create(scriptOperator, "a_1", "keep", "why", "print(1)\n");
    db.bindings = SCRIPT_TOOLS.map((name) => ({
      id: `bind_off_${name}`,
      catalog_kind: "native_tool",
      catalog_id: name,
      scope: "agent",
      scope_id: "a_1",
      enabled: false,
      connection_id: null,
    }));
    await loop.create_run("a_1", null);
    const names = (
      (db.run?.config_snapshot as { tools: Array<{ function: { name: string } }> }).tools ?? []
    ).map((item) => item.function.name);
    for (const name of SCRIPT_TOOLS) {
      assert.ok(!names.includes(name));
    }
    assert.ok(names.includes("report_issue"));
    assert.deepEqual((db.run?.config_snapshot as { scripts?: unknown[] }).scripts, []);
    const state = parsedState(String(db.create_args?.system_content));
    assert.deepEqual(state.scripts, []);
    const system = String(db.create_args?.system_content);
    assert.ok(!system.includes("script_create"));
    assert.ok(!system.includes("<capability"));
  });

  test("create_run_omits_note_guides_when_bindings_are_off", async () => {
    const { loop, db } = await seededLoop();
    loop._spawn = () => undefined;
    db.bindings = NOTE_TOOLS.map((name) => ({
      id: `bind_off_${name}`,
      catalog_kind: "native_tool",
      catalog_id: name,
      scope: "agent",
      scope_id: "a_1",
      enabled: false,
      connection_id: null,
    }));
    await loop.create_run("a_1", null);
    const names = (
      (db.run?.config_snapshot as { tools: Array<{ function: { name: string } }> }).tools ?? []
    ).map((item) => item.function.name);
    for (const name of NOTE_TOOLS) {
      assert.ok(!names.includes(name));
    }
    const system = String(db.create_args?.system_content);
    assert.ok(!system.includes("note_find"));
    assert.ok(!system.includes("note_write"));
    assert.ok(!system.includes("<capability"));
    assert.ok(system.includes("record_search"));
  });

  test("generate_refuses_script_create_when_it_was_not_offered", async () => {
    restoreBindings();
    const snapshot = {
      model: "openrouter/openai/gpt-4o-mini",
      temperature: 0,
      max_tokens: 32,
      max_steps: 30,
      tools: [{ type: "function", function: { name: "note_find" } }],
      secrets: [],
    };
    const db = new FakeDB(snapshot);
    const loop = makeLoop(db, {}, tempDir("guilds-gen-"), new FakeSandboxes());
    live.streamCompletion = fakeStream(db, [
      {
        id: "call_1",
        function: {
          name: "script_create",
          arguments: '{"name":"scratch","description":"why","source":"print(1)"}',
        },
      },
    ]);
    await loop._generate("r_1", 1);
    const tool = db.messages
      .filter((row) => (row.payload as Record<string, unknown>).role === "tool")
      .map((row) => row.payload as Record<string, unknown>);
    assert.match(String(tool[0]?.content), /not offered this run/);
    assert.equal((await loop.scripts.listForAgent("a_1")).length, 0);
    restoreBindings();
  });

  test("generate_drops_browser_when_it_is_now_off", async () => {
    restoreBindings();
    const snapshot = {
      model: "openrouter/openai/gpt-4o-mini",
      temperature: 0,
      max_tokens: 32,
      max_steps: 30,
      browser: true,
      tools: [
        { type: "function", function: { name: "browser_navigate" } },
        { type: "function", function: { name: "note_find" } },
      ],
      secrets: [],
    };
    const db = new FakeDB(snapshot);
    db.agent.config = { ...AGENT_CONFIG, browser: false };
    db.bindings = platformBindings();
    const loop = makeLoop(db, {}, tempDir("guilds-gen-"), new FakeSandboxes());
    live.streamCompletion = fakeStream(db, [
      { id: "call_1", function: { name: "browser_navigate", arguments: '{"url":"https://example.com"}' } },
    ]);
    await loop._generate("r_1", 1);
    const tools = db.messages
      .filter((row) => (row.payload as Record<string, unknown>).role === "tool")
      .map((row) => row.payload as Record<string, unknown>);
    assert.equal(tools.length, 1);
    assert.match(String(tools[0]?.content), /not offered this run/);
    restoreBindings();
  });

  test("create_run_with_message_appends_user_and_starts_generation", async () => {
    const { loop, db } = await seededLoop();
    loop._spawn = () => undefined;
    const result = await loop.create_run("a_1", "hello");
    assert.equal(db.create_args?.user_content, "hello");
    assert.deepEqual(
      db.messages.map((row) => (row.metadata as Record<string, unknown>).source),
      ["system", "ui"],
    );
    assert.deepEqual(db.messages[1]?.payload, { role: "user", content: "hello" });
    assert.deepEqual(db.messages[1]?.metadata, { generation: 1, source: "ui" });
    assert.equal(result.generating, true);
    assert.ok(loop._busy_agents.has("a_1"));
  });

  test("create_run_stores_attachment_refs_on_the_user_row", async () => {
    const { loop, db } = await seededLoop();
    loop._spawn = () => undefined;
    const attachments = [
      { id: "att_1", filename: "shot.png", mime: "image/png", kind: "image" as const },
    ];
    await loop.create_run("a_1", "", { attachments });
    assert.equal(db.create_args?.user_content, "");
    assert.deepEqual(db.messages[1]?.payload, { role: "user", content: "" });
    assert.deepEqual(db.messages[1]?.metadata, {
      generation: 1,
      source: "ui",
      attachments,
    });
  });

  test("add_message_stores_attachment_refs", async () => {
    const { loop, db } = await seededLoop();
    loop._spawn = () => undefined;
    const created = await loop.create_run("a_1", null);
    const attachments = [
      { id: "att_2", filename: "note.jpg", mime: "image/jpeg", kind: "image" as const },
    ];
    await loop.add_message(String(created.id), "look", attachments);
    const user = db.messages.find((row) => (row.payload as { role?: string }).role === "user");
    assert.deepEqual(user?.payload, { role: "user", content: "look" });
    assert.deepEqual(user?.metadata, { generation: 1, source: "ui", attachments });
  });

  test("create_run_group_context_keeps_last_ten", async () => {
    const { loop, db } = await seededLoop();
    loop._spawn = () => undefined;
    db.group_messages = Array.from({ length: 12 }, (_, index) => ({
      id: index + 1,
      guild_id: "guild_1",
      seq: index + 1,
      author_type: "user",
      author_name: "user",
      author_agent_id: null,
      content: `m${index + 1}`,
      tagged_names: [],
      tagged_agent_ids: [],
    }));
    await loop.create_run("a_1", "hello");
    const state = parsedState(String(db.create_args?.system_content));
    const history = (state.group as { history: Array<{ content: string }> }).history;
    assert.deepEqual(
      history.map((item) => item.content),
      Array.from({ length: 10 }, (_, index) => `m${index + 3}`),
    );
    assert.equal(history.length, CONTEXT_HISTORY_LIMIT);
  });

  test("create_run_group_context_uses_typesafe_history_and_falls_back", async () => {
    const { loop, db } = await seededLoop();
    loop._spawn = () => undefined;
    db.group_messages = Array.from({ length: 15 }, (_, index) => ({
      id: index + 1,
      guild_id: "guild_1",
      seq: index + 1,
      author_type: "user",
      author_name: "user",
      author_agent_id: null,
      content: `m${index + 1}`,
      tagged_names: [],
      tagged_agent_ids: [],
    }));
    const keepLatestAndOne = createGroupRouter({
      client: createTypeSafeClient({
        evaluate: async ({ questions }) => ({
          model: "jev-latest",
          answers: Object.fromEntries(
            Object.keys(questions).map((id) => [
              id,
              { type: "noul" as const, noul: id === "keep_5" ? 0.9 : 0.1 },
            ]),
          ),
        }),
      }),
    });
    (loop as { _group_router: typeof keepLatestAndOne })._group_router = keepLatestAndOne;
    await loop.create_run("a_1", "hello");
    const state = parsedState(String(db.create_args?.system_content));
    const history = (state.group as { history: Array<{ content: string }> }).history;
    assert.deepEqual(
      history.map((item) => item.content),
      ["m5", "m7", "m8", "m9", "m10", "m11", "m12", "m13", "m14", "m15"],
    );
  });

  test("create_run_without_message_is_allowed_while_agent_is_busy", async () => {
    const { loop, db } = await seededLoop();
    loop._spawn = () => undefined;
    await loop._begin("r_other", "a_1");
    const result = await loop.create_run("a_1", null);
    assert.equal(db.create_args?.user_content, null);
    assert.equal(result.generating, false);
    assert.ok(!loop._busy.has(String(result.id)));
  });

  test("list_run_payloads_only_marks_active_run_as_generating", async () => {
    const { loop, db } = await seededLoop();
    loop._spawn = () => undefined;
    await loop.create_run("a_1", null);
    const pastRun = { ...db.run, id: "r_past" };
    const activeRun = { ...db.run, id: "r_active" };
    db.listRuns = async () => [activeRun as Record<string, unknown>, pastRun as Record<string, unknown>];
    await loop._begin("r_active", "a_1");
    const payloads = await loop.list_run_payloads("a_1");
    const byId = Object.fromEntries(payloads.map((item) => [String(item.id), item]));
    assert.equal(byId.r_active?.generating, true);
    assert.equal(byId.r_past?.generating, false);
  });

  test("create_run_with_message_conflicts_while_agent_is_busy", async () => {
    const { loop } = await seededLoop();
    await loop._begin("r_other", "a_1");
    await assert.rejects(() => loop.create_run("a_1", "hello"), (error: unknown) => {
      assert.ok(error instanceof RunRequestError);
      assert.match(error.detail, /already generating/);
      assert.equal(error.status, 409);
      return true;
    });
  });

  test("first_user_message_on_idle_run_is_generation_one", async () => {
    const { loop, db } = await seededLoop();
    loop._spawn = () => undefined;
    const created = await loop.create_run("a_1", null);
    await loop.add_message(String(created.id), "hello");
    const user = db.messages[db.messages.length - 1];
    assert.deepEqual(
      db.messages.map((row) => (row.metadata as Record<string, unknown>).source),
      ["system", "ui"],
    );
    assert.deepEqual(user?.payload, { role: "user", content: "hello" });
    assert.deepEqual(user?.metadata, { generation: 1, source: "ui" });
    assert.equal(user?.seq, 1);
  });

  test("later_turn_does_not_reinject_state", async () => {
    const { loop, db } = await seededLoop();
    loop._spawn = () => undefined;
    const created = await loop.create_run("a_1", "hello");
    loop._end(String(created.id));
    await loop.add_message(String(created.id), "again");
    assert.deepEqual(
      db.messages.map((row) => (row.metadata as Record<string, unknown>).source),
      ["system", "ui", "ui"],
    );
    assert.deepEqual(db.messages[db.messages.length - 1]?.payload, { role: "user", content: "again" });
    assert.deepEqual(db.messages[db.messages.length - 1]?.metadata, { generation: 2, source: "ui" });
  });

  test("later_turn_keeps_opening_state_when_notes_change", async () => {
    const { loop, db, notes } = await seededLoop();
    loop._spawn = () => undefined;
    const created = await loop.create_run("a_1", "hello");
    const opening = parsedState(String(db.create_args?.system_content));
    loop._end(String(created.id));
    await notes.writeNote("private", "acme", "research", "researcher", "hello.md", "note");
    await loop.add_message(String(created.id), "again");
    assert.deepEqual(
      db.messages.map((row) => (row.metadata as Record<string, unknown>).source),
      ["system", "ui", "ui"],
    );
    assert.ok(!("notes" in opening));
    assert.deepEqual(opening.collections, []);
    assert.deepEqual(db.messages[db.messages.length - 1]?.payload, { role: "user", content: "again" });
  });

  test("pending_tool_calls_skips_resolved_ids", () => {
    const rows = [
      {
        payload: {
          role: "assistant",
          tool_calls: [
            { id: "call_1", function: { name: "bash" } },
            { id: "call_2", function: { name: "note_list" } },
          ],
        },
        metadata: { generation: 3 },
      },
      {
        payload: { role: "tool", tool_call_id: "call_1", content: "ok" },
        metadata: { generation: 3 },
      },
    ];
    const pending = pendingToolCalls(rows);
    assert.equal(pending.length, 1);
    const [call, generation] = pending[0]!;
    assert.equal(call.id, "call_2");
    assert.equal(generation, 3);
  });

  test("cancel_idle_run_is_noop", async () => {
    const { loop, db } = await seededLoop();
    loop._spawn = () => undefined;
    const created = await loop.create_run("a_1", null);
    assert.equal(await loop.cancel(String(created.id)), null);
    assert.ok(db.run);
    assert.deepEqual(db.run.errors, []);
    assert.deepEqual(
      db.messages.map((row) => (row.payload as Record<string, unknown>).role),
      ["system"],
    );
  });

  test("add_message_conflicts_while_same_run_generating", async () => {
    const { loop } = await seededLoop();
    loop._spawn = () => undefined;
    const created = await loop.create_run("a_1", null);
    await loop._begin(String(created.id), "a_1");
    await assert.rejects(() => loop.add_message(String(created.id), "hello"), (error: unknown) => {
      assert.ok(error instanceof RunRequestError);
      assert.equal(error.detail, "generation already in progress");
      assert.equal(error.status, 409);
      return true;
    });
  });

  test("cancel_during_llm_records_error_without_assistant", async () => {
    restoreBindings();
    const { loop, db } = await seededLoop();
    const started = deferred();
    live.streamCompletion = async function* hang(options: { signal?: AbortSignal }) {
      started.resolve();
      await hangForever(options.signal);
      yield ["done", completionReply("nope")];
    };
    const created = await loop.create_run("a_1", "hello");
    const queue = loop.subscribe(String(created.id));
    await started.promise;
    const cancelled = await loop.cancel(String(created.id));
    assert.ok(cancelled);
    assert.equal(cancelled.generating, false);
    const errors = db.run?.errors as Array<Record<string, unknown>>;
    assert.equal(errors[errors.length - 1]?.operation, "generation.cancelled");
    assert.ok(db.messages.every((row) => (row.payload as Record<string, unknown>).role !== "assistant"));
    const events: Array<[string, Record<string, unknown>]> = [];
    while (!queue.empty()) {
      events.push(await queue.get());
    }
    const errorEvent = events.find(([name]) => name === "run.error");
    assert.ok(errorEvent);
    assert.equal(errorEvent[1].operation, "generation.cancelled");
    restoreBindings();
  });

  test("provider_failure_is_error_without_assistant", async () => {
    restoreBindings();
    const { loop, db } = await seededLoop();
    live.streamCompletion = async function* boom() {
      throw new LLMError("request timed out");
      yield ["done", completionReply("nope")];
    };
    const created = await loop.create_run("a_1", "hello");
    await waitTask(loop, String(created.id));
    const errors = db.run?.errors as Array<Record<string, unknown>>;
    assert.equal(errors[errors.length - 1]?.operation, "llm.complete");
    assert.ok(db.messages.every((row) => (row.payload as Record<string, unknown>).role !== "assistant"));
    assert.ok(!loop._busy.has(String(created.id)));
    restoreBindings();
  });

  test("reconcile_fills_unresolved_tool_calls", async () => {
    const { loop, db } = await seededLoop();
    loop._spawn = () => undefined;
    await loop.create_run("a_1", null);
    db.messages.push({
      seq: 3,
      payload: {
        role: "assistant",
        content: null,
        tool_calls: [{ id: "call_1", function: { name: "bash", arguments: "{}" } }],
      },
      metadata: { generation: 1 },
      created_at: new Date(),
    });
    await loop.reconcile();
    const tool = db.messages[db.messages.length - 1];
    assert.deepEqual(tool?.payload, {
      role: "tool",
      tool_call_id: "call_1",
      content: withRemainingToolCalls("ERROR: execution interrupted", 49),
    });
    assert.equal((tool?.metadata as Record<string, unknown>).error, "execution interrupted");
    assert.equal((tool?.metadata as Record<string, unknown>).generation, 1);
    assert.equal((tool?.metadata as Record<string, unknown>).remaining_tool_calls, 49);
  });

  test("hard_cancel_during_settlement_resolves_each_call_once", async () => {
    restoreBindings();
    const snapshot = {
      model: "openrouter/openai/gpt-4o-mini",
      temperature: 0,
      max_tokens: 32,
      max_steps: 30,
      tools: [{ type: "function", function: { name: "script_run" } }],
      secrets: [],
    };
    const db = new FakeDB(snapshot);
    const started = deferred();
    const settling = deferred();
    const hang = abortableHang();
    const sandboxes = new FakeSandboxes();
    sandboxes.commands = {
      async run(_command: string, _opts?: unknown, handlers?: unknown) {
        const init = handlers as { onInit?: (init: { id?: string }) => unknown } | undefined;
        await init?.onInit?.({ id: "exec_1" });
        started.resolve();
        await hang.promise;
      },
      async interrupt(_executionId: string) {
        await settling.promise;
        hang.abort();
      },
    };
    const loop = makeLoop(db, {}, tempDir("guilds-gen-"), sandboxes);
    const originalOnCancel = loop._on_cancel;
    loop._on_cancel = async (...args) => {
      settling.resolve();
      await sleep(50);
      await originalOnCancel(...args);
    };
    live.cancelGraceMs = 0;
    await loop.scripts.create(scriptOperator, "a_1", "slow", "sleeps", "import time; time.sleep(30)");
    await loop.scripts.create(scriptOperator, "a_1", "two", "second", "print(2)");
    live.streamCompletion = fakeStream(db, [
      { id: "call_1", function: { name: "script_run", arguments: '{"name":"slow"}' } },
      { id: "call_2", function: { name: "script_run", arguments: '{"name":"two"}' } },
    ]);
    loop._start("r_1", "a_1", 1);
    await started.promise;
    const cancelled = await loop.cancel("r_1");
    assert.ok(cancelled);
    assert.equal(cancelled.generating, false);
    const toolIds = db.messages
      .filter((row) => (row.payload as Record<string, unknown>).role === "tool")
      .map((row) => (row.payload as Record<string, unknown>).tool_call_id);
    assert.deepEqual([...toolIds].sort(), ["call_1", "call_2"]);
    assert.deepEqual(
      (db.run.errors as Array<Record<string, unknown>>).map((entry) => entry.operation),
      ["generation.cancelled"],
    );
    restoreBindings();
  });

  test("cancel_resolves_remaining_tool_calls", async () => {
    restoreBindings();
    const snapshot = {
      model: "openrouter/openai/gpt-4o-mini",
      temperature: 0,
      max_tokens: 32,
      max_steps: 30,
      tools: [{ type: "function", function: { name: "script_run" } }],
      secrets: [],
    };
    const db = new FakeDB(snapshot);
    const started = deferred();
    const interrupted: string[] = [];
    const hang = abortableHang();
    const sandboxes = new FakeSandboxes();
    sandboxes.commands = {
      async run(_command: string, _opts?: unknown, handlers?: unknown) {
        const init = handlers as { onInit?: (init: { id?: string }) => unknown } | undefined;
        await init?.onInit?.({ id: "exec_1" });
        started.resolve();
        await hang.promise;
      },
      async interrupt(executionId: string) {
        interrupted.push(executionId);
        hang.abort();
      },
    };
    const loop = makeLoop(db, {}, tempDir("guilds-gen-"), sandboxes);
    await loop.scripts.create(scriptOperator, "a_1", "slow", "sleeps", "import time; time.sleep(30)");
    await loop.scripts.create(scriptOperator, "a_1", "two", "second", "print(2)");
    live.streamCompletion = fakeStream(db, [
      { id: "call_1", function: { name: "script_run", arguments: '{"name":"slow"}' } },
      { id: "call_2", function: { name: "script_run", arguments: '{"name":"two"}' } },
    ]);
    loop._start("r_1", "a_1", 1);
    await started.promise;
    const cancelled = await loop.cancel("r_1");
    assert.ok(cancelled);
    assert.equal(cancelled.generating, false);
    assert.deepEqual(interrupted, ["exec_1"]);
    const toolContents = db.messages
      .filter((row) => (row.payload as Record<string, unknown>).role === "tool")
      .map((row) => (row.payload as Record<string, unknown>).content);
    assert.deepEqual(toolContents, [
      withRemainingToolCalls("ERROR: execution interrupted", 49),
      withRemainingToolCalls("ERROR: execution interrupted", 48),
    ]);
    const toolIds = new Set(
      db.messages
        .filter((row) => (row.payload as Record<string, unknown>).role === "tool")
        .map((row) => (row.payload as Record<string, unknown>).tool_call_id),
    );
    assert.deepEqual(toolIds, new Set(["call_1", "call_2"]));
    restoreBindings();
  });

  test("generate_starts_browser_sandbox", async () => {
    restoreBindings();
    const snapshot = {
      model: "openrouter/openai/gpt-4o-mini",
      temperature: 0,
      max_tokens: 32,
      max_steps: 30,
      browser: true,
      tools: [],
      secrets: [],
    };
    const db = new FakeDB(snapshot);
    const sandboxes = new FakeSandboxes();
    const loop = makeLoop(db, {}, tempDir("guilds-gen-"), sandboxes);
    live.streamCompletion = async function* stream() {
      yield ["done", completionReply("done")];
    };
    await loop._generate("r_1", 1);
    assert.deepEqual(sandboxes.browser_flags, [true]);
    restoreBindings();
  });

  test("ensure_browser_requires_flag", async () => {
    const db = new FakeDB({});
    db.agent.config = { ...AGENT_CONFIG, browser: false };
    const loop = makeLoop(db, {}, tempDir("guilds-gen-"), new FakeSandboxes());
    await assert.rejects(() => loop.ensure_browser("a_1"), (error: unknown) => {
      assert.ok(error instanceof RunRequestError);
      assert.match(error.detail, /browser is not enabled/);
      assert.equal(error.status, 409);
      return true;
    });
  });

  test("ensure_browser_fills_sparse_recipe_config", async () => {
    const db = new FakeDB({});
    db.agent.config = { model: AGENT_CONFIG.model, browser: true };
    const sandboxes = new FakeSandboxes();
    const loop = makeLoop(db, {}, tempDir("guilds-gen-"), sandboxes, {
      idleTimeoutMs: 15 * 60 * 1000,
    });
    const sandbox = await loop.ensure_browser("a_1");
    assert.ok(sandbox);
    assert.deepEqual(sandboxes.browser_flags, [true]);
    loop._cancel_idle("a_1");
  });

  test("ensure_browser_wakes_idle_sandbox", async () => {
    const db = new FakeDB({});
    db.agent.config = { ...AGENT_CONFIG, browser: true };
    const sandboxes = new FakeSandboxes();
    const loop = makeLoop(db, {}, tempDir("guilds-gen-"), sandboxes, {
      idleTimeoutMs: 15 * 60 * 1000,
    });
    const sandbox = await loop.ensure_browser("a_1");
    assert.ok(sandbox);
    assert.deepEqual(sandboxes.created, [["a_1", {}]]);
    assert.deepEqual(sandboxes.browser_flags, [true]);
    assert.ok(loop._idle_tasks.has("a_1"));
    loop._cancel_idle("a_1");
  });

  test("ensure_browser_during_generation_keeps_running_sandbox", async () => {
    const db = new FakeDB({});
    db.agent.config = { ...AGENT_CONFIG, browser: true };
    const sandboxes = new FakeSandboxes();
    const loop = makeLoop(db, {}, tempDir("guilds-gen-"), sandboxes);
    await sandboxes.ensure("a_1", {}, [], { browser: true });
    await loop._begin("r_1", "a_1");
    const sandbox = await loop.ensure_browser("a_1");
    assert.ok(sandbox);
    assert.deepEqual(sandboxes.created, [["a_1", {}]]);
    assert.ok(!loop._idle_tasks.has("a_1"));
  });

  test("ensure_cli_requires_flag", async () => {
    const db = new FakeDB({});
    db.agent.config = { ...AGENT_CONFIG, browser: false, cli: false };
    const loop = makeLoop(db, {}, tempDir("guilds-gen-"), new FakeSandboxes());
    await assert.rejects(() => loop.ensure_cli("a_1"), (error: unknown) => {
      assert.ok(error instanceof RunRequestError);
      assert.match(error.detail, /cli is not enabled/);
      assert.equal(error.status, 409);
      return true;
    });
  });

  test("create_run_omits_script_tools_when_scripting_is_off", async () => {
    const { loop, db } = await seededLoop();
    loop._spawn = () => undefined;
    db.agent.config = { ...AGENT_CONFIG, scripting: false };
    await loop.scripts.create(scriptOperator, "a_1", "keep", "why", "print(1)\n");
    await loop.create_run("a_1", null);
    const names = (
      (db.run?.config_snapshot as { tools: Array<{ function: { name: string } }> }).tools ?? []
    ).map((item) => item.function.name);
    for (const name of SCRIPT_TOOLS) {
      assert.ok(!names.includes(name));
    }
    assert.deepEqual((db.run?.config_snapshot as { scripts?: unknown[] }).scripts, []);
  });

  test("create_run_offers_parameterised_script_as_a_tool", async () => {
    const { loop, db } = await seededLoop();
    loop._spawn = () => undefined;
    const schema = {
      type: "object",
      properties: { symbol: { type: "string" } },
      required: ["symbol"],
    };
    await loop.scripts.create(
      scriptOperator,
      "a_1",
      "priced",
      "price a bag",
      "import json,sys; print(json.load(sys.stdin)['symbol'])\n",
      schema,
    );
    await loop.create_run("a_1", null);
    const tools = (db.run?.config_snapshot as { tools: Array<Record<string, unknown>> }).tools ?? [];
    const priced = tools.find((tool) => {
      const fn = tool.function as { name?: string } | undefined;
      return fn?.name === "priced";
    }) as { function: { name: string; description: string; parameters: Record<string, unknown> } } | undefined;
    assert.ok(priced);
    assert.equal(priced.function.description, "price a bag");
    assert.deepEqual(priced.function.parameters, {
      type: "object",
      properties: { symbol: { type: "string" } },
      required: ["symbol"],
    });
  });

  test("generation offers a snapshotted first-class script even when tools omitted it", async () => {
    restoreBindings();
    const snapshot = {
      model: "openrouter/openai/gpt-4o-mini",
      temperature: 0,
      max_tokens: 32,
      max_steps: 30,
      tools: [{ type: "function", function: { name: "script_run" } }],
      scripts: [
        {
          id: "script_1",
          name: "priced",
          description: "price a bag",
          parameters: {
            type: "object",
            properties: { symbol: { type: "string" } },
            required: ["symbol"],
          },
          source: "print(1)\n",
          source_hash: "abc",
        },
      ],
      secrets: [],
    };
    const db = new FakeDB(snapshot);
    const sandboxes = new FakeSandboxes();
    const commands = sandboxes.commands as FakeCommands & {
      envs: Array<Record<string, string> | undefined>;
    };
    commands.envs = [];
    const originalRun = commands.run.bind(commands);
    commands.run = async (command, opts) => {
      commands.envs.push((opts as { envs?: Record<string, string> } | undefined)?.envs);
      return originalRun(command, opts);
    };
    const loop = makeLoop(db, {}, tempDir("guilds-gen-"), sandboxes);
    const offered: unknown[] = [];
    live.streamCompletion = async function* stream(options: { messages: Array<Record<string, unknown>>; tools?: unknown[] | null }) {
      db.llm_histories.push([...options.messages]);
      if (options.tools) {
        offered.push(...options.tools);
      }
      const payload =
        db.llm_histories.length === 1
          ? {
              role: "assistant",
              content: null,
              tool_calls: [
                { id: "call_1", function: { name: "priced", arguments: '{"symbol":"ETH"}' } },
              ],
            }
          : { role: "assistant", content: "done" };
      yield [
        "done" as const,
        {
          payload,
          metadata: {
            usage: { input_tokens: 1, output_tokens: 1, cache_read_tokens: 0 },
            latency_ms: 1,
            finish_reason: "tool_calls" in payload ? "tool_calls" : "stop",
            model: "test",
            response_id: "c1",
            provider_request_id: null,
            cost_usd: 0.0,
          },
        },
      ];
    };
    await loop._generate("r_1", 1);
    const names = offered.map((tool) => {
      const record = tool as { function?: { name?: string } };
      return record.function?.name;
    });
    assert.ok(names.includes("priced"));
    assert.ok(names.includes("script_run"));
    assert.deepEqual(withoutWorkspaceMeasure(commands.commands), [launcherCommand("priced")]);
    assert.equal(workspaceMeasureCount(commands.commands), 1);
    assert.deepEqual(commands.envs[0]?.[SCRIPT_ARGS_ENV], JSON.stringify({ symbol: "ETH" }));
    restoreBindings();
  });

  test("create_run_omits_memory_write_when_binding_is_off", async () => {
    const { loop, db } = await seededLoop();
    loop._spawn = () => undefined;
    db.bindings = [
      {
        id: "bind_off_memory_write",
        catalog_kind: "native_tool",
        catalog_id: "memory_write",
        scope: "agent",
        scope_id: "a_1",
        enabled: false,
        connection_id: null,
      },
    ];
    await loop.create_run("a_1", null);
    const names = (
      (db.run?.config_snapshot as { tools: Array<{ function: { name: string } }> }).tools ?? []
    ).map((item) => item.function.name);
    assert.ok(!names.includes("memory_write"));
    const system = String(db.create_args?.system_content);
    assert.ok(!system.includes("memory_write"));
    assert.ok(system.includes("<memory>"));
    assert.ok(!system.includes("<capability"));
  });

  test("create_run_omits_memory_when_memory_is_off", async () => {
    const { loop, db } = await seededLoop();
    loop._spawn = () => undefined;
    db.agent.config = { ...AGENT_CONFIG, memory: false };
    await loop.create_run("a_1", null);
    const names = (
      (db.run?.config_snapshot as { tools: Array<{ function: { name: string } }> }).tools ?? []
    ).map((item) => item.function.name);
    assert.ok(!names.includes("memory_write"));
    assert.equal((db.run?.config_snapshot as { memory?: boolean }).memory, false);
    const system = String(db.create_args?.system_content ?? "");
    assert.ok(!system.includes("<memory>"));
    assert.ok(!system.includes("memory_write"));
  });

  test("ensure_cli_wakes_plain_sandbox_and_starts_terminal", async () => {
    const db = new FakeDB({});
    db.agent.config = { ...AGENT_CONFIG, browser: false };
    const sandboxes = new FakeSandboxes();
    const loop = makeLoop(db, {}, tempDir("guilds-gen-"), sandboxes, {
      idleTimeoutMs: 5 * 60 * 1000,
    });
    const sandbox = await loop.ensure_cli("a_1");
    assert.ok(sandbox);
    assert.deepEqual(sandboxes.created, [["a_1", {}]]);
    assert.deepEqual(sandboxes.browser_flags, [false]);
    assert.equal(sandboxes.cli_starts, 1);
    assert.ok(loop._idle_tasks.has("a_1"));
    loop._cancel_idle("a_1");
  });

  test("ensure_cli_keeps_browser_agent_on_its_browser_sandbox", async () => {
    const db = new FakeDB({});
    db.agent.config = { ...AGENT_CONFIG, browser: true };
    const sandboxes = new FakeSandboxes();
    const loop = makeLoop(db, {}, tempDir("guilds-gen-"), sandboxes, {
      idleTimeoutMs: 5 * 60 * 1000,
    });
    await loop.ensure_cli("a_1");
    assert.deepEqual(sandboxes.browser_flags, [true]);
    assert.equal(sandboxes.cli_starts, 1);
    loop._cancel_idle("a_1");
  });

  test("ensure_cli_and_ensure_browser_keep_a_coding_agent_on_its_coding_sandbox", async () => {
    const db = new FakeDB({});
    db.agent.config = { ...AGENT_CONFIG, browser: true, coding: true };
    const sandboxes = new FakeSandboxes();
    const loop = makeLoop(db, {}, tempDir("guilds-gen-"), sandboxes, {
      idleTimeoutMs: 5 * 60 * 1000,
    });
    await loop.ensure_cli("a_1");
    await loop.ensure_browser("a_1");
    assert.deepEqual(sandboxes.browser_flags, [true, true]);
    assert.deepEqual(sandboxes.coding_flags, [true, true]);
    loop._cancel_idle("a_1");
  });

  test("ensure_cli_during_generation_uses_running_sandbox", async () => {
    const db = new FakeDB({});
    db.agent.config = { ...AGENT_CONFIG, browser: false };
    const sandboxes = new FakeSandboxes();
    const loop = makeLoop(db, {}, tempDir("guilds-gen-"), sandboxes);
    await sandboxes.ensure("a_1", {}, [], { browser: false });
    await loop._begin("r_1", "a_1");
    const sandbox = await loop.ensure_cli("a_1");
    assert.ok(sandbox);
    assert.deepEqual(sandboxes.created, [["a_1", {}]]);
    assert.equal(sandboxes.cli_starts, 1);
    assert.ok(!loop._idle_tasks.has("a_1"));
  });

  test("ensure_cli_reports_terminal_start_failure", async () => {
    const db = new FakeDB({});
    db.agent.config = { ...AGENT_CONFIG, browser: false };
    const sandboxes = new FakeSandboxes();
    sandboxes.cli_failure = "terminal failed to start";
    const loop = makeLoop(db, {}, tempDir("guilds-gen-"), sandboxes, {
      idleTimeoutMs: 5 * 60 * 1000,
    });
    await assert.rejects(() => loop.ensure_cli("a_1"), (error: unknown) => {
      assert.ok(error instanceof RunRequestError);
      assert.equal(error.status, 503);
      assert.match(error.detail, /terminal failed to start/);
      return true;
    });
    loop._cancel_idle("a_1");
  });

  test("cli_proxy_target_needs_a_running_sandbox_and_carries_the_secret_path", async () => {
    const db = new FakeDB({});
    const sandboxes = new FakeSandboxes();
    const loop = makeLoop(db, {}, tempDir("guilds-gen-"), sandboxes);
    await assert.rejects(() => loop.cli_proxy_target("a_1"), (error: unknown) => {
      assert.ok(error instanceof RunRequestError);
      assert.equal(error.status, 503);
      assert.match(error.detail, /sandbox is not running/);
      return true;
    });
    sandboxes.running.add("a_1");
    const [base, headers] = await loop.cli_proxy_target("a_1");
    assert.equal(base, `http://cli.test/t/${sandboxes.cli_token}`);
    assert.deepEqual(headers, { "OPEN-SANDBOX-API-KEY": "k" });
    assert.equal(sandboxes.cli_starts, 1);
  });

  test("touch_sandbox_restarts_only_an_armed_idle_timer", async () => {
    const db = new FakeDB({});
    const sandboxes = new FakeSandboxes();
    const loop = makeLoop(db, {}, tempDir("guilds-gen-"), sandboxes, { idleTimeoutMs: 60_000 });
    loop.touch_sandbox("a_1");
    assert.ok(!loop._idle_tasks.has("a_1"));
    loop._schedule_idle("a_1");
    const armed = loop._idle_tasks.get("a_1");
    loop.touch_sandbox("a_1");
    const restarted = loop._idle_tasks.get("a_1");
    assert.ok(restarted);
    assert.notEqual(restarted, armed);
    await loop._begin("r_1", "a_1");
    loop._schedule_idle("a_1");
    const duringRun = loop._idle_tasks.get("a_1");
    loop.touch_sandbox("a_1");
    assert.equal(loop._idle_tasks.get("a_1"), duringRun);
    loop._cancel_idle("a_1");
  });

  test("refresh_sandbox_destroys_idle", async () => {
    const db = new FakeDB({});
    const sandboxes = new FakeSandboxes();
    sandboxes.running.add("a_1");
    const loop = makeLoop(db, {}, tempDir("guilds-gen-"), sandboxes);
    await loop.refresh_sandbox("a_1");
    assert.deepEqual(sandboxes.destroyed, ["a_1"]);
    assert.ok(!loop._stale_sandboxes.has("a_1"));
  });

  test("refresh_sandbox_waits_until_generation_ends", async () => {
    const db = new FakeDB({});
    const sandboxes = new FakeSandboxes();
    const loop = makeLoop(db, {}, tempDir("guilds-gen-"), sandboxes);
    await loop._begin("r_1", "a_1");
    await loop.refresh_sandbox("a_1");
    assert.deepEqual(sandboxes.destroyed, []);
    assert.ok(loop._stale_sandboxes.has("a_1"));
  });

  test("generation_injects_secret_granted_after_run_start", async () => {
    restoreBindings();
    process.env.SECRETS_MASTER_KEY = HEX_MASTER_KEY;
    const snapshot = {
      model: "openrouter/openai/gpt-4o-mini",
      temperature: 0,
      max_tokens: 32,
      max_steps: 30,
      tools: [],
      secrets: [],
    };
    const db = new FakeDB(snapshot);
    db.agent.org_id = "org_1";
    db.secrets = [liveSecret()];
    const sandboxes = new FakeSandboxes();
    const loop = makeLoop(db, {}, tempDir("guilds-gen-"), sandboxes);
    live.streamCompletion = fakeStream(db, []);
    await loop._generate("r_1", 1);
    assert.deepEqual(sandboxes.created, [["a_1", { WALLET_PRIVATE_KEY: "wallet-secret" }]]);
    assert.deepEqual((db.run.config_snapshot as Record<string, unknown>).secrets, [
      { id: "sec_1", name: "WALLET_PRIVATE_KEY", description: "signs sends" },
    ]);
    restoreBindings();
  });

  test("secret_access_changed_syncs_snapshot_and_refreshes", async () => {
    process.env.SECRETS_MASTER_KEY = HEX_MASTER_KEY;
    const db = new FakeDB({ secrets: [] });
    db.agent.org_id = "org_1";
    db.secrets = [liveSecret()];
    const sandboxes = new FakeSandboxes();
    sandboxes.running.add("a_1");
    const loop = makeLoop(db, {}, tempDir("guilds-gen-"), sandboxes);
    await loop.secretAccessChanged(["a_1"]);
    assert.deepEqual((db.run.config_snapshot as Record<string, unknown>).secrets, [
      { id: "sec_1", name: "WALLET_PRIVATE_KEY", description: "signs sends" },
    ]);
    assert.deepEqual(sandboxes.destroyed, ["a_1"]);
  });

  test("later_turn_lists_secret_granted_after_run_start", async () => {
    process.env.SECRETS_MASTER_KEY = HEX_MASTER_KEY;
    const { loop, db } = await seededLoop();
    loop._spawn = () => undefined;
    const created = await loop.create_run("a_1", "hello");
    loop._end(String(created.id));
    db.secrets = [liveSecret()];
    await loop.add_message(String(created.id), "again");
    assert.deepEqual(
      db.messages.map((row) => (row.metadata as Record<string, unknown>).source),
      ["system", "ui", "ui"],
    );
    assert.deepEqual((db.run?.config_snapshot as Record<string, unknown>).secrets, [
      { id: "sec_1", name: "WALLET_PRIVATE_KEY", description: "signs sends" },
    ]);
  });

  test("later_turn_keeps_opening_memory", async () => {
    const { loop, db, notes } = await seededLoop();
    loop._spawn = () => undefined;
    const created = await loop.create_run("a_1", "hello");
    loop._end(String(created.id));
    await notes.writeMemory("acme", "research", "researcher", "inbox", {
      source: "r_test",
      replacedBy: "run r_test (direct)",
    });
    await loop.add_message(String(created.id), "again");
    assert.deepEqual(
      db.messages.map((row) => (row.metadata as Record<string, unknown>).source),
      ["system", "ui", "ui"],
    );
    assert.deepEqual(db.messages[db.messages.length - 1]?.payload, { role: "user", content: "again" });
    assert.deepEqual(db.messages[db.messages.length - 1]?.metadata, { generation: 2, source: "ui" });
  });

  test("schedule_wake_reminds_and_marks_skipped_without_write", async () => {
    restoreBindings();
    const { loop, db } = await seededLoop();
    let calls = 0;
    live.streamCompletion = async function* replies() {
      calls += 1;
      yield ["done", { payload: { role: "assistant", content: "checked" }, metadata: {} }];
    };
    await loop.deliver_schedule_run({
      id: "sch_1",
      agent_id: "a_1",
      cron: "*/30 * * * *",
      instruction: "check inbox",
    });
    await waitTask(loop, String(db.run?.id));
    assert.equal(calls, 2);
    const reminder = db.messages.filter((row) =>
      String((row.payload as Record<string, unknown>).content ?? "").startsWith("Memory: this wake"),
    );
    assert.equal(reminder.length, 1);
    assert.deepEqual(reminder[0]?.metadata, { generation: 1, source: "memory" });
    assert.equal((db.run?.metadata as Record<string, unknown>).memory_skipped, true);
    restoreBindings();
  });

  test("reasoning_streams_as_its_own_event_and_lands_in_assistant_metadata", async () => {
    restoreBindings();
    const { loop, db } = await seededLoop();
    live.streamCompletion = async function* thinks() {
      yield ["reasoning", "weigh "];
      yield ["reasoning", "options"];
      yield ["delta", "ok"];
      const reply = completionReply("ok");
      yield ["done", { ...reply, metadata: { ...reply.metadata, reasoning: "weigh options" } }];
    };
    const published: Array<[string, Record<string, unknown>]> = [];
    const publish = loop.publish.bind(loop);
    loop.publish = async (runId, event, data) => {
      published.push([event, data]);
      await publish(runId, event, data);
    };
    const created = await loop.create_run("a_1", "hello");
    await waitTask(loop, String(created.id));
    assert.deepEqual(
      published.filter(([event]) => event === "assistant.reasoning.delta").map(([, data]) => data.text),
      ["weigh ", "options"],
    );
    assert.deepEqual(
      published.filter(([event]) => event === "assistant.delta").map(([, data]) => data.text),
      ["ok"],
    );
    const assistant = db.messages.find((row) => (row.payload as Record<string, unknown>).role === "assistant");
    assert.ok(assistant);
    assert.equal((assistant.metadata as Record<string, unknown>).reasoning, "weigh options");
    assert.equal("reasoning" in (assistant.payload as Record<string, unknown>), false);
    restoreBindings();
  });

  test("schedule_wake_reminder_write_clears_skip", async () => {
    restoreBindings();
    const { loop, db } = await seededLoop();
    let calls = 0;
    live.streamCompletion = async function* replies() {
      calls += 1;
      if (calls === 1) {
        yield ["done", { payload: { role: "assistant", content: "checked" }, metadata: {} }];
        return;
      }
      yield [
        "done",
        {
          payload: {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: "call_mem",
                function: {
                  name: "memory_write",
                  arguments: JSON.stringify({ content: "inbox\nread mail" }),
                },
              },
            ],
          },
          metadata: {},
        },
      ];
    };
    await loop.deliver_schedule_run({
      id: "sch_1",
      agent_id: "a_1",
      cron: "*/30 * * * *",
      instruction: "check inbox",
    });
    await waitTask(loop, String(db.run?.id));
    assert.equal(calls, 2);
    assert.ok(!(db.run?.metadata as Record<string, unknown> | undefined)?.memory_skipped);
    const written = db.messages.filter(
      (row) => (row.metadata as Record<string, unknown>).tool_name === "memory_write",
    );
    assert.ok(written.length);
    assert.ok(String((written[0]?.payload as Record<string, unknown>).content).startsWith("memory.md written"));
    restoreBindings();
  });

  test("direct_run_does_not_remind_memory", async () => {
    restoreBindings();
    const { loop, db } = await seededLoop();
    let calls = 0;
    live.streamCompletion = async function* replies() {
      calls += 1;
      yield ["done", { payload: { role: "assistant", content: "ok" }, metadata: {} }];
    };
    const created = await loop.create_run("a_1", "hello");
    await waitTask(loop, String(created.id));
    assert.equal(calls, 1);
    assert.ok(
      !db.messages.some((row) =>
        String((row.payload as Record<string, unknown>).content ?? "").startsWith("Memory: this wake"),
      ),
    );
    assert.ok(!(db.run?.metadata as Record<string, unknown> | undefined)?.memory_skipped);
    restoreBindings();
  });

  test("schedule_wake_skips_reminder_when_memory_write_off", async () => {
    restoreBindings();
    const { loop, db } = await seededLoop();
    db.bindings = [
      {
        id: "bind_off",
        catalog_kind: "native_tool",
        catalog_id: "memory_write",
        scope: "agent",
        scope_id: "a_1",
        enabled: false,
        connection_id: null,
      },
    ];
    let calls = 0;
    live.streamCompletion = async function* replies() {
      calls += 1;
      yield ["done", { payload: { role: "assistant", content: "checked" }, metadata: {} }];
    };
    await loop.deliver_schedule_run({
      id: "sch_1",
      agent_id: "a_1",
      cron: "*/30 * * * *",
      instruction: "check inbox",
    });
    await waitTask(loop, String(db.run?.id));
    const names = (
      (db.run?.config_snapshot as { tools: Array<{ function: { name: string } }> }).tools ?? []
    ).map((item) => item.function.name);
    assert.ok(!names.includes("memory_write"));
    assert.equal(calls, 1);
    const system = String(db.create_args?.system_content ?? "");
    assert.ok(!system.includes("memory_write"));
    assert.ok(system.includes("<memory>"));
    assert.ok(
      !db.messages.some((row) =>
        String((row.payload as Record<string, unknown>).content ?? "").startsWith("Memory: this wake"),
      ),
    );
    assert.ok(!(db.run?.metadata as Record<string, unknown> | undefined)?.memory_skipped);
    restoreBindings();
  });

  test("org concurrent cap rejects a second busy agent", async () => {
    const db = new FakeDB({});
    const agents: Record<string, Record<string, unknown>> = {
      a_1: { ...db.agent, id: "a_1", org_id: "org_1" },
      a_2: { ...db.agent, id: "a_2", org_id: "org_1" },
    };
    db.getAgent = async (agentId: string) => agents[agentId] ?? null;
    const loop = makeLoop(db, {}, tempDir("guilds-gen-"), {}, {
      policy: limitedPolicy({ maxConcurrentRuns: 1 }),
    });
    await loop._begin("r_1", "a_1");
    await assert.rejects(() => loop._begin("r_2", "a_2"), (error: unknown) => {
      assert.ok(error instanceof ConflictError);
      assert.match(error.message, /plan limit reached: concurrent generations/);
      return true;
    });
  });

  test("spend limit skips coding-API models", async () => {
    const db = new FakeDB({});
    db.monthlyUsage = { cost_usd: 0.05 };
    db.orgApiKey = null;
    const loop = makeLoop(db, {}, tempDir("guilds-gen-"), {}, {
      policy: limitedPolicy({ monthlyCostLimitUsd: 0.01 }),
    });
    await loop._begin("r_1", "a_1");
    await assert.rejects(
      () =>
        loop._llm_completion("r_1", {
          model: "kimi/kimi-for-coding",
          messages: [],
          temperature: 0,
          max_tokens: 8,
          tools: null,
        }),
      (error: unknown) => {
        assert.ok(error instanceof generationMod.RunLimitError);
        assert.equal(error.operation, "generation.model_key");
        return true;
      },
    );
  });

  test("spend limit fails the model call before streaming", async () => {
    const db = new FakeDB({});
    db.monthlyUsage = { cost_usd: 0.05 };
    const loop = makeLoop(db, {}, tempDir("guilds-gen-"), {}, {
      policy: limitedPolicy({ monthlyCostLimitUsd: 0.01 }),
    });
    await loop._begin("r_1", "a_1");
    await assert.rejects(
      () =>
        loop._llm_completion("r_1", {
          model: "openrouter/openai/gpt-5.6-luna",
          messages: [],
          temperature: 0,
          max_tokens: 8,
          tools: null,
        }),
      (error: unknown) => {
        assert.ok(error instanceof generationMod.RunLimitError);
        assert.equal(error.operation, "generation.spend_limit");
        return true;
      },
    );
  });

  test("an organisation the policy bars fails the model call before streaming", async () => {
    const db = new FakeDB({});
    const loop = makeLoop(db, {}, tempDir("guilds-gen-"), {}, {
      policy: limitedPolicy({}, new PolicyError(402, "subscription required: the trial has ended")),
    });
    await loop._begin("r_1", "a_1");
    await assert.rejects(
      () =>
        loop._llm_completion("r_1", {
          model: "openrouter/openai/gpt-5.6-luna",
          messages: [],
          temperature: 0,
          max_tokens: 8,
          tools: null,
        }),
      (error: unknown) => {
        assert.ok(error instanceof generationMod.RunLimitError);
        assert.equal(error.operation, "generation.subscription");
        assert.equal(error.message, "subscription required: the trial has ended");
        return true;
      },
    );
  });

  test("event bus drops stalled subscribers", async () => {
    const loop = makeLoop({}, {}, tempDir("guilds-gen-"), new FakeSandboxes());
    const queue = loop.subscribe("r_1");
    for (let index = 0; index < 4096; index += 1) {
      await queue.put(["stalled", {}]);
    }
    await loop.publish("r_1", "run.error", { operation: "generation.cancelled" });
    assert.equal(queue.size, 4096);
  });
});
