import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { slotPorts } from "../../src/machines/index.js";
import { RunSandboxes, type AgentSeat, type MachineSpec } from "../../src/sandbox/index.js";
import { SandboxError, wrapOpenSandbox } from "../../src/sandbox/sdk.js";

// What a manager does when the sandbox cannot run one of its commands.

const STANDARD: MachineSpec = { id: "mach_1", orgId: "org_1", box: "standard", cpu: 1, memoryMib: 2048 };
const SEAT: AgentSeat = { agentId: "a_1", machineId: "mach_1", slot: 2, browserLanguage: "fr-FR" };

/** A manager on a fake SDK whose containers answer each command with `run`. */
function sandboxesRunning(run: (command: string) => Promise<unknown>): RunSandboxes {
  let created = 0;
  const wrapped = wrapOpenSandbox({
    SandboxManager: {
      create() {
        return {
          async listSandboxInfos() {
            return { items: [] };
          },
          async killSandbox() {},
        };
      },
    },
    Sandbox: {
      async create() {
        created += 1;
        return { id: `sbx_${created}`, commands: { run } };
      },
      async connect() {
        throw new Error("no connect");
      },
    },
  });
  return new RunSandboxes(
    {
      url: "http://opensandbox:8080",
      apiKey: "test",
      image: "agent-runtime:0.4",
      workspaceRoot: mkdtempSync(path.join(tmpdir(), "guilds-sandbox-")),
    },
    { sdk: wrapped },
  );
}

test("a new container's harnesses are the ones its image lists", async () => {
  const sandboxes = sandboxesRunning(async () => ({ exitCode: 0, logs: { stdout: [{ text: "codex claude-code bogus codex" }] } }));
  await sandboxes.start();
  await sandboxes.ensure(STANDARD);
  assert.deepEqual(sandboxes.harnessesOf(STANDARD.id), ["codex", "claude-code"]);
});

test("a new container that cannot run the harness list read leaves its harnesses unknown", async () => {
  const sandboxes = sandboxesRunning(async () => {
    throw new Error("execd is not up");
  });
  await sandboxes.start();
  const created = await sandboxes.ensure(STANDARD);
  assert.equal(created.id, "sbx_1");
  assert.equal(sandboxes.harnessesOf(STANDARD.id), null);
});

/** A manager whose browser wait makes `readySeconds` probes, recording each sleep instead of sleeping. */
function browserSandboxes(readySeconds: number): { sandboxes: RunSandboxes; sleeps: number[] } {
  const sleeps: number[] = [];
  const sandboxes = new RunSandboxes(
    {
      url: "http://opensandbox:8080",
      apiKey: "test",
      image: "agent-runtime:0.4",
      workspaceRoot: mkdtempSync(path.join(tmpdir(), "guilds-sandbox-")),
      readySeconds,
    },
    {
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    },
  );
  return { sandboxes, sleeps };
}

test("startBrowser waits for the browser when the sandbox cannot run the start command", async () => {
  const { sandboxes } = browserSandboxes(1);
  const commands: string[] = [];
  const fake = {
    id: "sbx_fake",
    commands: {
      async run(command: string) {
        commands.push(command);
        if (command.startsWith("/usr/local/bin/agent-browser-start")) {
          throw new Error("the start timed out");
        }
        return { exit_code: 0, logs: { stdout: [{ text: "[]" }] } };
      },
    },
  };
  await sandboxes.startBrowser(fake, SEAT);
  assert.ok(commands.some((command) => command.includes(`${slotPorts(2).cdp}/json/version`)));
});

test("waitForBrowser probes again after a probe the sandbox cannot run", async () => {
  const { sandboxes, sleeps } = browserSandboxes(3);
  let probes = 0;
  const fake = {
    id: "sbx_fake",
    commands: {
      async run(command: string) {
        if (command.includes("/json/version")) {
          probes += 1;
          if (probes === 1) {
            throw new Error("execd is not up");
          }
        }
        return { exit_code: 0, logs: { stdout: [{ text: "[]" }] } };
      },
    },
  };
  await sandboxes.waitForBrowser(fake, SEAT);
  assert.equal(probes, 2);
  assert.deepEqual(sleeps, [1000]);
});

test("waitForBrowser answers when the sandbox cannot run the blank navigation", async () => {
  const { sandboxes } = browserSandboxes(1);
  let navigated = false;
  const fake = {
    id: "sbx_fake",
    commands: {
      async run(command: string) {
        if (command.includes("guilds-browser")) {
          navigated = true;
          throw new Error("the navigation timed out");
        }
        if (command.includes("/json/list")) {
          return { exit_code: 0, logs: { stdout: [{ text: '[{"url":"https://guilds.run/","title":"guilds.run"}]' }] } };
        }
        return { exit_code: 0, logs: { stdout: [] } };
      },
    },
  };
  await sandboxes.waitForBrowser(fake, SEAT);
  assert.equal(navigated, true);
});

test("a browser that never answers on a sandbox that runs nothing reports vnc, cdp, and the relay down", async () => {
  const { sandboxes } = browserSandboxes(1);
  const fake = {
    id: "sbx_fake",
    commands: {
      async run(): Promise<never> {
        throw new Error("execd is not up");
      },
    },
  };
  await assert.rejects(
    () => sandboxes.waitForBrowser(fake, SEAT),
    (error: unknown) => {
      assert.ok(error instanceof SandboxError);
      assert.equal(error.message, "browser session failed to start\nvnc=down\ncdp=down\nrelay=down");
      return true;
    },
  );
});
