import assert from "node:assert/strict";
import { test } from "node:test";
import { slotPorts } from "../../src/machines/index.js";
import { CLI_ENTRYPOINT, RunSandboxes, SandboxError, type AgentSeat } from "../../src/sandbox/index.js";
import { tempDir } from "../helpers/env.js";

const TOKEN = "0123456789abcdef".repeat(3);
const SEAT: AgentSeat = { agentId: "a_1", machineId: "mach_1", slot: 3, browserLanguage: "en-US" };

function manager(): RunSandboxes {
  return new RunSandboxes({
    url: "http://sandbox:8080",
    apiKey: "host-key",
    image: "agent-runtime:0.4",
    workspaceRoot: tempDir("guilds-sbx-"),
  });
}

function handle(
  run: (command: string) => Promise<unknown>,
  endpoint?: (port: number) => Promise<unknown>,
) {
  return {
    id: "sbx_1",
    commands: { run: run as never },
    ...(endpoint ? { getEndpoint: endpoint as never } : {}),
  };
}

test("startCli runs the helper with the ports of the agent's slot and returns the secret it prints", async () => {
  const commands: string[] = [];
  const sandbox = handle(async (command) => {
    commands.push(command);
    return { exit_code: 0, logs: { stdout: [{ text: "starting" }, { text: `${TOKEN}\n` }] } };
  });
  assert.equal(await manager().startCli(sandbox, SEAT), TOKEN);
  const ports = slotPorts(3);
  assert.deepEqual(commands, [`${CLI_ENTRYPOINT} a_1 ${ports.ttyd} ${ports.portsFrom} ${ports.portsTo}`]);
});

test("startCli rejects a failed helper and a malformed secret", async () => {
  const failed = handle(async () => ({ exit_code: 1, logs: { stdout: [{ text: TOKEN }] } }));
  await assert.rejects(() => manager().startCli(failed, SEAT), SandboxError);
  const garbled = handle(async () => ({
    exit_code: 0,
    logs: { stdout: [{ text: "not a token" }] },
  }));
  await assert.rejects(() => manager().startCli(garbled, SEAT), SandboxError);
  const broken = handle(async () => {
    throw new Error("execd unreachable");
  });
  await assert.rejects(() => manager().startCli(broken, SEAT), /execd unreachable/);
});

test("cliTarget resolves the agent's terminal port under the daemon's secret path", async () => {
  const sandbox = handle(
    async () => ({}),
    async (port) => ({
      endpoint: `sandbox:8080/route/${port}`,
      headers: { "OPEN-SANDBOX-API-KEY": "host-key" },
    }),
  );
  const [base, headers] = await manager().cliTarget(sandbox, SEAT, TOKEN);
  assert.equal(base, `http://sandbox:8080/route/${slotPorts(3).ttyd}/t/${TOKEN}`);
  assert.deepEqual(headers, { "OPEN-SANDBOX-API-KEY": "host-key" });
  await assert.rejects(
    () =>
      manager().cliTarget(
        handle(async () => ({})),
        SEAT,
        TOKEN,
      ),
    SandboxError,
  );
});
