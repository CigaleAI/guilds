import assert from "node:assert/strict";
import { test } from "node:test";
import { CLI_ENTRYPOINT, CLI_PORT, RunSandboxes, SandboxError } from "../../src/sandbox/index.js";
import { tempDir } from "../helpers/env.js";

const TOKEN = "0123456789abcdef".repeat(3);

function manager(): RunSandboxes {
  return new RunSandboxes({
    url: "http://sandbox:8080",
    apiKey: "host-key",
    image: "agent-runtime:0.3",
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

test("startCli runs the helper and returns the secret it prints", async () => {
  const commands: string[] = [];
  const sandbox = handle(async (command) => {
    commands.push(command);
    return { exit_code: 0, logs: { stdout: [{ text: "starting" }, { text: `${TOKEN}\n` }] } };
  });
  assert.equal(await manager().startCli(sandbox), TOKEN);
  assert.deepEqual(commands, [CLI_ENTRYPOINT]);
});

test("startCli rejects a failed helper and a malformed secret", async () => {
  const failed = handle(async () => ({ exit_code: 1, logs: { stdout: [{ text: TOKEN }] } }));
  await assert.rejects(() => manager().startCli(failed), SandboxError);
  const garbled = handle(async () => ({
    exit_code: 0,
    logs: { stdout: [{ text: "not a token" }] },
  }));
  await assert.rejects(() => manager().startCli(garbled), SandboxError);
  const broken = handle(async () => {
    throw new Error("execd unreachable");
  });
  await assert.rejects(() => manager().startCli(broken), /execd unreachable/);
});

test("cliTarget resolves the terminal port under the daemon's secret path", async () => {
  const sandbox = handle(
    async () => ({}),
    async (port) => ({
      endpoint: `sandbox:8080/route/${port}`,
      headers: { "OPEN-SANDBOX-API-KEY": "host-key" },
    }),
  );
  const [base, headers] = await manager().cliTarget(sandbox, TOKEN);
  assert.equal(base, `http://sandbox:8080/route/${CLI_PORT}/t/${TOKEN}`);
  assert.deepEqual(headers, { "OPEN-SANDBOX-API-KEY": "host-key" });
  await assert.rejects(
    () =>
      manager().cliTarget(
        handle(async () => ({})),
        TOKEN,
      ),
    SandboxError,
  );
});
