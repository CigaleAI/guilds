import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import type { Harness } from "../../src/db/schema/index.js";
import { RunEventBus } from "../../src/generation/events.js";
import { HarnessLoop } from "../../src/generation/harness-loop.js";
import { agentHome } from "../../src/lib/agent-file.js";
import {
  RunSandboxes,
  agentSandbox,
  prepareWorkspace,
  seatEnvironment,
  type AgentSeat,
  type MachineSpec,
} from "../../src/sandbox/index.js";
import { invokeTool } from "../../src/toolbox/index.js";
import { HEX_MASTER_KEY } from "../helpers/env.js";
import { gated, run, startOpenSandboxServer, stdoutOf } from "../helpers/opensandbox-server.js";
import { toolFixture } from "../helpers/toolbox.js";

// A live turn of each harness in the runtime image, on a real subscription, and a live turn of a
// Claude Code subscription agent. Each runs when its credential is in the environment:
// CLAUDE_CODE_OAUTH_TOKEN, CURSOR_API_KEY, or for Codex CODEX_AUTH_JSON, the path of an auth.json
// from `codex login`.
const IMAGE = process.env.CONTRACT_RUNTIME_IMAGE ?? "agent-runtime:0.4";
const imageMissing =
  gated || (run("docker", ["image", "inspect", IMAGE], false).status !== 0 ? `build ${IMAGE} first (make runtime-image)` : false);
const MACHINE: MachineSpec = { id: "mach_harness", orgId: "org_contract", box: "code", cpu: 2, memoryMib: 4096 };

const LIVE: Array<{ harness: Harness; credential: string }> = [
  { harness: "claude-code", credential: "CLAUDE_CODE_OAUTH_TOKEN" },
  { harness: "codex", credential: "CODEX_AUTH_JSON" },
  { harness: "cursor", credential: "CURSOR_API_KEY" },
];

for (const { harness, credential } of LIVE) {
  const skip = imageMissing || (process.env[credential] ? false : `set ${credential} to run the live ${harness} turn`);
  test(`a live ${harness} turn changes a file in the repository and names its session`, { skip, timeout: 600_000 }, async () => {
    process.env.SECRETS_MASTER_KEY ??= HEX_MASTER_KEY;
    const server = await startOpenSandboxServer();
    const sandboxes = new RunSandboxes({
      url: server.url,
      apiKey: server.apiKey,
      image: IMAGE,
      workspaceRoot: server.workspaceRoot,
    });
    await sandboxes.start();
    const agentId = `a_live_${harness.replace("-", "_")}`;
    const seat: AgentSeat = { agentId, machineId: MACHINE.id, slot: 0, browserLanguage: "en-US" };
    try {
      prepareWorkspace(server.workspaceRoot, MACHINE.id, agentId);
      const machine = await sandboxes.ensure(MACHINE);
      const secrets: Record<string, string> =
        credential === "CODEX_AUTH_JSON" ? {} : { [credential]: String(process.env[credential]) };
      const sandbox = agentSandbox(machine, agentHome(agentId), { ...secrets, ...seatEnvironment(seat) });
      if (credential === "CODEX_AUTH_JSON") {
        await machine.files!.writeFiles([
          { path: `${agentHome(agentId)}/.codex/auth.json`, data: readFileSync(String(process.env.CODEX_AUTH_JSON), "utf8") },
        ]);
      }
      const setup = await sandbox.commands.run(
        "mkdir -p repos/live && cd repos/live && git init -q -b main && git -c user.name=t -c user.email=t@t.invalid commit -q --allow-empty -m start && echo ready",
        { timeoutSeconds: 30 },
      );
      assert.equal(stdoutOf(setup).trim(), "ready");
      const ctx = toolFixture({
        run_id: "r_live",
        agent_id: agentId,
        guild_id: "g_1",
        sandbox,
        secrets,
        harness,
        code_repositories: ["live"],
      });
      const [payload, metadata] = await invokeTool(
        ctx.services, ctx.run, ctx.hooks,
        {
          id: "call_live",
          type: "function",
          function: {
            name: "code_task",
            arguments: JSON.stringify({
              brief: "Create a file named hello.txt whose only content is the word hi. Do not commit.",
              timeout_minutes: 8,
            }),
          },
        },
      );
      const text = String(payload.content);
      assert.equal(metadata.status, "completed", text);
      assert.ok(typeof metadata.session_id === "string" && metadata.session_id, text);
      assert.equal(metadata.files_changed, 1, text);
      assert.ok(text.includes("hello.txt"), text);
    } finally {
      await sandboxes.destroy(MACHINE.id).catch(() => undefined);
      await sandboxes.close();
      await server.stop();
    }
  });
}

const claudeSkip = imageMissing || (process.env.CLAUDE_CODE_OAUTH_TOKEN ? false : "set CLAUDE_CODE_OAUTH_TOKEN to run the live subscription turn");

test("a live Claude Code subscription turn answers under the system prompt that replaces its own", { skip: claudeSkip, timeout: 600_000 }, async () => {
  process.env.SECRETS_MASTER_KEY ??= HEX_MASTER_KEY;
  const server = await startOpenSandboxServer();
  const sandboxes = new RunSandboxes({ url: server.url, apiKey: server.apiKey, image: IMAGE, workspaceRoot: server.workspaceRoot });
  await sandboxes.start();
  const agentId = "a_live_subscription";
  const seat: AgentSeat = { agentId, machineId: MACHINE.id, slot: 0, browserLanguage: "en-US" };
  try {
    prepareWorkspace(server.workspaceRoot, MACHINE.id, agentId);
    const machine = await sandboxes.ensure(MACHINE);
    const secrets = { CLAUDE_CODE_OAUTH_TOKEN: String(process.env.CLAUDE_CODE_OAUTH_TOKEN) };
    const sandbox = agentSandbox(machine, agentHome(agentId), { ...secrets, ...seatEnvironment(seat) });
    const rows: Array<{ seq: number; payload: Record<string, unknown>; metadata: Record<string, unknown> }> = [
      {
        seq: 0,
        payload: { role: "system", content: "You are Quill, an agent of a test guild. Answer every message with the single word PINEAPPLE, then stop." },
        metadata: {},
      },
      { seq: 1, payload: { role: "user", content: "Run `echo ready` in the shell, then answer." }, metadata: { generation: 1, source: "ui" } },
    ];
    const metadata: Record<string, unknown> = {};
    const errors: unknown[] = [];
    const events = new RunEventBus({
      nextSeq: async () => rows.length,
      insertMessage: async (message: { seq: number; payload: Record<string, unknown>; metadata: Record<string, unknown> }) => {
        rows.push(message);
        return { ...message, id: rows.length, run_id: "r_live_turn", created_at: new Date().toISOString(), cost_usd: null };
      },
      appendRunError: async (_runId: string, entry: unknown) => {
        errors.push(entry);
        return [];
      },
    } as never);
    const loop = new HarnessLoop({
      db: {
        getAgent: async () => null,
        listMessages: async () => rows,
        mergeRunMetadata: async (_runId: string, extra: Record<string, unknown>) => {
          Object.assign(metadata, extra);
        },
      } as never,
      events,
      machines: null as never,
    });
    const ctx = toolFixture({ run_id: "r_live_turn", agent_id: agentId, guild_id: "g_1", sandbox, secrets, harness: "claude-code" });
    const gen = {
      runId: "r_live_turn",
      generation: 1,
      log: { run_id: "r_live_turn" },
      run: { id: "r_live_turn", metadata: {} },
      agent: { id: agentId },
      source: "subscription",
      snapshot: { model: null, harness: "claude-code", harness_model: null, harness_effort: null },
    };
    await loop.runTurn(gen as never, { run: ctx.run, hooks: ctx.hooks, schemas: [], secrets, connections: new Map(), maxToolCalls: 50 });
    assert.deepEqual(errors, []);
    const kept = rows.slice(2);
    assert.ok(kept.every((row) => row.metadata.from_harness === "claude-code"));
    assert.match(String(kept.at(-1)?.payload.content), /PINEAPPLE/, "the run's system prompt replaced Claude Code's own");
    assert.ok(kept.some((row) => row.payload.role === "tool"), "the shell call and its result are rows");
    assert.ok(typeof (metadata.harness_turn as { session_id?: unknown })?.session_id === "string");
  } finally {
    await sandboxes.destroy(MACHINE.id).catch(() => undefined);
    await sandboxes.close();
    await server.stop();
  }
});
