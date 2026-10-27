import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import type { Harness } from "../../src/db/schema/index.js";
import { agentHome } from "../../src/lib/agent-file.js";
import {
  RunSandboxes,
  agentSandbox,
  prepareWorkspace,
  seatEnvironment,
  type AgentSeat,
  type MachineSpec,
} from "../../src/sandbox/index.js";
import { createToolContext, invokeTool } from "../../src/toolbox/index.js";
import { HEX_MASTER_KEY } from "../helpers/env.js";
import { gated, run, startOpenSandboxServer, stdoutOf } from "../helpers/opensandbox-server.js";

// A live turn of each harness in the runtime image, on a real subscription. Each runs when its
// credential is in the environment: CLAUDE_CODE_OAUTH_TOKEN, CURSOR_API_KEY, or for Codex
// CODEX_AUTH_JSON, the path of an auth.json from `codex login`.
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
      const ctx = createToolContext({
        run_id: "r_live",
        agent_id: agentId,
        guild_id: "g_1",
        sandbox,
        secrets,
        harness,
        code_repositories: ["live"],
      });
      const [payload, metadata] = await invokeTool(
        ctx,
        {
          id: "call_live",
          function: {
            name: "code_task",
            arguments: JSON.stringify({
              brief: "Create a file named hello.txt whose only content is the word hi. Do not commit.",
              timeout_minutes: 8,
            }),
          },
        },
        secrets,
        65536,
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
