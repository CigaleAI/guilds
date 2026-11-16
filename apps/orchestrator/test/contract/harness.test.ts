import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import type { Harness } from "../../src/db/schema/index.js";
import type { AddressInfo } from "node:net";
import { buildHarnessMcpApp } from "../../src/app.js";
import { RunEventBus } from "../../src/generation/events.js";
import { HarnessLoop } from "../../src/generation/harness-loop.js";
import { HarnessMcpServer } from "../../src/generation/harness-mcp.js";
import { ToolCalls, type GenerationTools } from "../../src/generation/tool-calls.js";
import { harnessNeedsRepository } from "../../src/coding/harnesses.js";
import { agentHome } from "../../src/lib/agent-file.js";
import {
  RunSandboxes,
  agentSandbox,
  prepareWorkspace,
  seatEnvironment,
  type AgentSeat,
  type MachineSpec,
} from "../../src/sandbox/index.js";
import { schemasFor } from "../../src/toolbox/index.js";
import { gated, run, startOpenSandboxServer, stdoutOf } from "../helpers/opensandbox-server.js";
import { toolFixture } from "../helpers/toolbox.js";

// Live turns of a subscription agent on each harness in the runtime image, on a real
// subscription, one of each calling a Guilds tool on the orchestrator's MCP server; Cursor's and
// Antigravity's in a repository, under the run's prompt as a rule. Each runs when its credential
// is in the environment: CLAUDE_CODE_OAUTH_TOKEN, CURSOR_API_KEY, for Codex
// CODEX_AUTH_JSON, the path of an auth.json from `codex login`, and for Antigravity
// ANTIGRAVITY_OAUTH_TOKEN, the path of the `antigravity-oauth-token` a sign-in with `agy` writes.
const IMAGE = process.env.CONTRACT_RUNTIME_IMAGE ?? "agent-runtime:0.4";
const imageMissing =
  gated || (run("docker", ["image", "inspect", IMAGE], false).status !== 0 ? `build ${IMAGE} first (make runtime-image)` : false);
const MACHINE: MachineSpec = { id: "mach_harness", orgId: "org_contract", box: "code", cpu: 2, memoryMib: 4096 };

/** The login files each harness that logs in reads in the home, from the file its credential variable names. */
const LOGIN_FILES: Partial<Record<string, string>> = {
  CODEX_AUTH_JSON: ".codex/auth.json",
  ANTIGRAVITY_OAUTH_TOKEN: ".gemini/antigravity-cli/antigravity-oauth-token",
};

/** The secrets a live turn on the harness whose credential is `credential` runs on: its token, or none for a login. */
function liveSecrets(credential: string): Record<string, string> {
  return LOGIN_FILES[credential] === undefined ? { [credential]: String(process.env[credential]) } : {};
}

/** Writes the login `credential` names into agent `agentId`'s home on `machine`; nothing for a token. */
async function writeLogin(machine: Awaited<ReturnType<RunSandboxes["ensure"]>>, agentId: string, credential: string): Promise<void> {
  const file = LOGIN_FILES[credential];
  if (file !== undefined) {
    await machine.files!.writeFiles([{ path: `${agentHome(agentId)}/${file}`, data: readFileSync(String(process.env[credential]), "utf8") }]);
  }
}

const claudeSkip = imageMissing || (process.env.CLAUDE_CODE_OAUTH_TOKEN ? false : "set CLAUDE_CODE_OAUTH_TOKEN to run the live subscription turn");
const codexSkip = imageMissing || (process.env.CODEX_AUTH_JSON ? false : "set CODEX_AUTH_JSON to run the live Codex subscription turn");

/** The variable each harness's live subscription turn reads its credential from. */
const CREDENTIALS: Record<Harness, string> = {
  "claude-code": "CLAUDE_CODE_OAUTH_TOKEN",
  codex: "CODEX_AUTH_JSON",
  cursor: "CURSOR_API_KEY",
  antigravity: "ANTIGRAVITY_OAUTH_TOKEN",
};

type Row = { seq: number; payload: Record<string, unknown>; metadata: Record<string, unknown> };

/**
 * Where this host's MCP listener binds for a sandbox on the default bridge, and the host the
 * sandbox reaches it by: loopback and host.docker.internal on Docker Desktop, the bridge's gateway
 * on a Linux engine (docs/architecture/deployment.md).
 */
function sandboxReach(): { bind: string; host: string } {
  if (run("docker", ["info", "--format", "{{.OperatingSystem}}"]).stdout.trim() === "Docker Desktop") {
    return { bind: "127.0.0.1", host: "host.docker.internal" };
  }
  const gateway = run("docker", ["network", "inspect", "bridge", "--format", "{{(index .IPAM.Config 0).Gateway}}"]).stdout.trim();
  return { bind: gateway, host: gateway };
}

/**
 * One live turn of a subscription agent on `harness` on run `r_live_turn`, opened by `prompt` under
 * the system prompt `system`, whose harness is served the native tools `offered` on a listener of
 * the orchestrator's MCP server, with `postFromRun` as its guild chat. The run's rows, its errors,
 * and its metadata.
 */
async function liveSubscriptionTurn(
  harness: Harness,
  system: string,
  prompt: string,
  offered: string[],
  posted: string[],
) {
  const server = await startOpenSandboxServer();
  const sandboxes = new RunSandboxes({ url: server.url, apiKey: server.apiKey, image: IMAGE, workspaceRoot: server.workspaceRoot });
  await sandboxes.start();
  const agentId = "a_live_subscription";
  const seat: AgentSeat = { agentId, machineId: MACHINE.id, slot: 0, browserLanguage: "en-US" };
  const reach = sandboxReach();
  const rows: Row[] = [
    { seq: 0, payload: { role: "system", content: system }, metadata: {} },
    { seq: 1, payload: { role: "user", content: prompt }, metadata: { generation: 1, source: "ui" } },
  ];
  const metadata: Record<string, unknown> = {};
  const errors: unknown[] = [];
  const listening: Array<{ close(): Promise<void> }> = [];
  try {
    prepareWorkspace(server.workspaceRoot, MACHINE.id, agentId);
    const machine = await sandboxes.ensure(MACHINE);
    const secrets = liveSecrets(CREDENTIALS[harness]);
    const sandbox = agentSandbox(machine, agentHome(agentId), { ...secrets, ...seatEnvironment(seat) });
    await writeLogin(machine, agentId, CREDENTIALS[harness]);
    // Cursor and Antigravity run a subscription agent only in a repository; its turn starts there.
    const repositories = harnessNeedsRepository(harness) ? ["live"] : [];
    if (repositories.length) {
      const setup = await sandbox.commands.run(
        "mkdir -p repos/live && cd repos/live && git init -q -b main && git -c user.name=t -c user.email=t@t.invalid commit -q --allow-empty -m start && echo ready",
        { timeoutSeconds: 30 },
      );
      assert.equal(stdoutOf(setup).trim(), "ready");
    }
    const events = new RunEventBus({
      nextSeq: async () => rows.length,
      insertMessage: async (message: Row) => {
        rows.push(message);
        return { ...message, id: rows.length, run_id: "r_live_turn", created_at: new Date().toISOString(), cost_usd: null };
      },
      appendRunError: async (_runId: string, entry: unknown) => {
        errors.push(entry);
        return [];
      },
    } as never);
    const group_chat = {
      postFromRun: async (_runId: string, _agentId: string, _guildId: string, _name: string, content: string) => {
        posted.push(content);
        return "posted to the guild chat";
      },
    };
    const ctx = toolFixture({
      run_id: "r_live_turn",
      agent_id: agentId,
      guild_id: "g_1",
      sandbox,
      secrets,
      harness,
      offered_tools: new Set(offered),
      group_chat: group_chat as never,
      code_repositories: repositories,
    });
    const schemas = schemasFor(offered);
    const tools: GenerationTools = { run: ctx.run, hooks: ctx.hooks, schemas, secrets, connections: new Map(), maxToolCalls: 50 };
    const agent = { id: agentId, org_id: "org_contract", guild_id: "g_1", config: { model: null, harness, browser: false, coding: false, scripting: false, memory: false } };
    const toolCalls = new ToolCalls({
      db: { getAgent: async () => null, getRun: async () => null, listMessages: async () => rows },
      events,
      tools: ctx.services,
    } as never);
    const mcpDb = { getAgent: async () => agent, listBindingsCovering: async () => [], listMessages: async () => rows };
    const probe = await buildHarnessMcpApp(new HarnessMcpServer({ db: mcpDb as never, toolCalls }, "http://unused"));
    await probe.listen({ host: reach.bind, port: 0 });
    const port = (probe.server.address() as AddressInfo).port;
    await probe.close();
    const mcp = new HarnessMcpServer({ db: mcpDb as never, toolCalls }, `http://${reach.host}:${port}`);
    const listener = await buildHarnessMcpApp(mcp);
    await listener.listen({ host: reach.bind, port });
    listening.push(listener);
    const loop = new HarnessLoop({
      db: {
        getAgent: async () => null,
        getRun: async () => null,
        completeRun: async () => undefined,
        listMessages: async () => rows,
        mergeRunMetadata: async (_runId: string, extra: Record<string, unknown>) => {
          Object.assign(metadata, extra);
        },
      } as never,
      events,
      machines: null as never,
      mcp,
      attachments: null,
    });
    const gen = {
      runId: "r_live_turn",
      generation: 1,
      log: { run_id: "r_live_turn" },
      run: { id: "r_live_turn", kind: "direct", metadata: {} },
      agent,
      source: "subscription",
      snapshot: { model: null, harness, harness_model: null, harness_effort: null, max_steps: 30, max_turn_minutes: 10, tools: schemas },
    };
    await loop.runTurn(gen as never, tools);
    return { rows: rows.slice(2), errors, metadata };
  } finally {
    for (const listener of listening) {
      await listener.close();
    }
    await sandboxes.destroy(MACHINE.id).catch(() => undefined);
    await sandboxes.close();
    await server.stop();
  }
}

test("a live Claude Code subscription turn answers under the system prompt that replaces its own", { skip: claudeSkip, timeout: 600_000 }, async () => {
  const { rows, errors, metadata } = await liveSubscriptionTurn(
    "claude-code",
    "You are Quill, an agent of a test guild. Answer every message with the single word PINEAPPLE, then stop.",
    "Run `echo ready` in the shell, then answer.",
    [],
    [],
  );
  assert.deepEqual(errors, []);
  assert.ok(rows.every((row) => row.metadata.from_harness === "claude-code"));
  assert.match(String(rows.at(-1)?.payload.content), /PINEAPPLE/, "the run's system prompt replaced Claude Code's own");
  assert.ok(rows.some((row) => row.payload.role === "tool"), "the shell call and its result are rows");
  assert.ok(typeof (metadata.harness_turn as { session_id?: unknown })?.session_id === "string");
  const usage = rows.at(-1)?.metadata.usage as { input_tokens?: number } | undefined;
  assert.ok((usage?.input_tokens ?? 0) > 0, "the reply records the turn's tokens");
  assert.equal(rows.at(-1)?.metadata.cost_source, "subscription");
});

test("a live Claude Code subscription turn calls a Guilds tool on the orchestrator's MCP server", { skip: claudeSkip, timeout: 600_000 }, async () => {
  const posted: string[] = [];
  const { rows, errors } = await liveSubscriptionTurn(
    "claude-code",
    "You are Quill, an agent of a test guild. Your tool `mcp__guilds__group_post` posts to the guild's chat. " +
      "Call it exactly once with the content PINEAPPLE, then answer with the single word done.",
    "Tell the guild.",
    ["group_post"],
    posted,
  );
  assert.deepEqual(errors, []);
  assert.deepEqual(posted, ["PINEAPPLE"], "the call reached the guild chat through the server");
  const call = rows.find((row) => JSON.stringify(row.payload.tool_calls ?? []).includes('"name":"group_post"'));
  assert.ok(call, "the call is the run's own tool call");
  assert.equal(call.metadata.from_harness, undefined);
  const result = rows.find((row) => row.seq === call.seq + 1);
  assert.equal(result?.payload.role, "tool");
  assert.match(String(result?.payload.content), /remaining_tool_calls: 49$/);
  assert.ok(!rows.some((row) => JSON.stringify(row.payload).includes("mcp__guilds__group_post")), "the harness's own events for it make no row");
});

test("a live Codex subscription turn answers under the system prompt that replaces its instructions, and records its tokens", { skip: codexSkip, timeout: 600_000 }, async () => {
  const { rows, errors, metadata } = await liveSubscriptionTurn(
    "codex",
    "You are Quill, an agent of a test guild. Answer every message with the single word PINEAPPLE, then stop.",
    "Run `echo ready` in the shell, then answer.",
    [],
    [],
  );
  assert.deepEqual(errors, []);
  assert.ok(rows.every((row) => row.metadata.from_harness === "codex"));
  assert.match(String(rows.at(-1)?.payload.content), /PINEAPPLE/, "the run's system prompt replaced Codex's instructions");
  assert.ok(rows.some((row) => row.payload.role === "tool"), "the shell call and its result are rows");
  assert.ok(typeof (metadata.harness_turn as { session_id?: unknown })?.session_id === "string");
  const usage = rows.at(-1)?.metadata.usage as { input_tokens?: number } | undefined;
  assert.ok((usage?.input_tokens ?? 0) > 0, "the reply records the turn's tokens");
  assert.equal(rows.at(-1)?.metadata.cost_source, "subscription");
});

test("a live Codex subscription turn calls a Guilds tool on the orchestrator's MCP server", { skip: codexSkip, timeout: 600_000 }, async () => {
  const posted: string[] = [];
  const { rows, errors } = await liveSubscriptionTurn(
    "codex",
    "You are Quill, an agent of a test guild. Your tool `mcp__guilds__group_post` posts to the guild's chat. " +
      "Call it exactly once with the content PINEAPPLE, then answer with the single word done.",
    "Tell the guild.",
    ["group_post"],
    posted,
  );
  assert.deepEqual(errors, []);
  assert.deepEqual(posted, ["PINEAPPLE"], "the call reached the guild chat through the server");
  const call = rows.find((row) => JSON.stringify(row.payload.tool_calls ?? []).includes('"name":"group_post"'));
  assert.ok(call, "the call is the run's own tool call");
  assert.equal(call.metadata.from_harness, undefined);
  assert.ok(!rows.some((row) => JSON.stringify(row.payload).includes("mcp__guilds__group_post")), "the harness's own events for it make no row");
});

for (const { harness, label, tool } of [
  { harness: "cursor", label: "Cursor", tool: "group_post" },
  { harness: "antigravity", label: "Antigravity", tool: "mcp_guilds_group_post" },
] as const) {
  const skip = imageMissing || (process.env[CREDENTIALS[harness]] ? false : `set ${CREDENTIALS[harness]} to run the live ${label} subscription turn`);
  test(`a live ${label} subscription turn in its repository follows the run's prompt as a rule beside its own, and calls a Guilds tool on the orchestrator's MCP server`, { skip, timeout: 600_000 }, async () => {
    const posted: string[] = [];
    const { rows, errors, metadata } = await liveSubscriptionTurn(
      harness,
      `You are Quill, an agent of a test guild. Your tool \`${tool}\` posts to the guild's chat. ` +
        "Call it exactly once with the content PINEAPPLE, then answer with the single word done.",
      "Tell the guild.",
      ["group_post"],
      posted,
    );
    assert.deepEqual(errors, []);
    assert.deepEqual(posted, ["PINEAPPLE"], "the call reached the guild chat through the server, as the rule asked");
    const call = rows.find((row) => JSON.stringify(row.payload.tool_calls ?? []).includes('"name":"group_post"'));
    assert.ok(call, "the call is the run's own tool call");
    assert.equal(call.metadata.from_harness, undefined);
    assert.ok(rows.filter((row) => row.metadata.from_harness !== undefined).every((row) => row.metadata.from_harness === harness));
    assert.ok(typeof (metadata.harness_turn as { session_id?: unknown })?.session_id === "string");
  });
}
