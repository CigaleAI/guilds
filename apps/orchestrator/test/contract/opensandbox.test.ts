import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { requestHeaders } from "../../src/sandbox/index.js";
import { gated, startOpenSandboxServer, stdoutOf } from "../helpers/opensandbox-server.js";

test("run sandbox lifecycle against the pinned OpenSandbox server", { skip: gated }, async () => {
  const server = await startOpenSandboxServer();
  const { config, sdk, manager, workspaceRoot } = server;
  const sandboxIds = new Set<string>();
  let sessionId: string | undefined;
  try {
    const runId = "r_contract";
    const workspace = path.join(workspaceRoot, runId);
    mkdirSync(workspace);
    writeFileSync(path.join(workspace, "host-marker.txt"), "from-host\n");

    let sandbox = await sdk.Sandbox.create("python:3.12-slim", {
      timeout: null,
      timeoutSeconds: null,
      metadata: { run_id: runId },
      resource: { cpu: "1", memory: "512Mi" },
      volumes: [
        {
          name: "workspace",
          host: { path: workspace },
          mount_path: "/home/agent",
          read_only: false,
        },
      ],
      connection_config: config,
    });
    sandboxIds.add(sandbox.id);

    const info = await manager.getSandboxInfo!(sandbox.id);
    assert.equal(info.expires_at ?? null, null);

    const matches = await manager.listSandboxInfos!({
      states: ["Running"],
      metadata: { run_id: runId },
    });
    const listed = matches.sandbox_infos ?? matches.sandboxInfos ?? matches.items ?? [];
    assert.deepEqual(listed.map((item) => item.id), [sandbox.id]);

    const marker = await sandbox.commands.run("cat host-marker.txt", { workingDirectory: "/home/agent" });
    assert.equal(stdoutOf(marker).trim(), "from-host");

    const persisted = await sandbox.commands.run("printf 'from-sandbox\\n' > persisted.txt", {
      workingDirectory: "/home/agent",
    });
    assert.equal(persisted.exit_code ?? persisted.exitCode, 0);
    assert.equal(readFileSync(path.join(workspace, "persisted.txt"), "utf8"), "from-sandbox\n");

    sessionId = await sandbox.commands.createSession!("/home/agent");
    const background = await sandbox.commands.runInSession!(
      sessionId,
      "sleep 120 >/dev/null 2>&1 & echo $! > background.pid",
    );
    assert.equal(background.exit_code ?? background.exitCode, 0);

    await sandbox.close?.();
    sandbox = await sdk.Sandbox.connect(nextId(sandboxIds), { connection_config: config });

    const alive = await sandbox.commands.runInSession!(
      sessionId,
      "kill -0 $(cat background.pid) && printf 'alive\\n'",
    );
    assert.equal(stdoutOf(alive).trim(), "alive");

    const cancellable = await sandbox.commands.run("sleep 120", {
      background: true,
      workingDirectory: "/home/agent",
      on_init: (init: { id?: string }) => {
        assert.ok(init.id);
      },
    } as never);
    assert.ok(cancellable.id);
    assert.equal((await sandbox.commands.getCommandStatus!(cancellable.id)).running, true);
    await sandbox.commands.interrupt!(cancellable.id);
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const status = await sandbox.commands.getCommandStatus!(cancellable.id);
      if (status.running === false) {
        break;
      }
      await delay(100);
      if (attempt === 39) {
        throw new Error("interrupted command remained active");
      }
    }

    assert.ok(sandbox.getEndpoint);
    const endpoint = await sandbox.getEndpoint(44772);
    assert.ok(endpoint.endpoint);
    assert.equal(typeof endpoint.build_request_headers, "function");
    requestHeaders(endpoint, config);

    await sandbox.commands.deleteSession!(sessionId);
    sessionId = undefined;
    await sandbox.destroy?.();
    sandboxIds.delete(sandbox.id);

    const recreated = await sdk.Sandbox.create("python:3.12-slim", {
      timeout: null,
      metadata: { run_id: runId },
      resource: { cpu: "1", memory: "512Mi" },
      volumes: [
        {
          name: "workspace",
          host: { path: workspace },
          mount_path: "/home/agent",
          read_only: false,
        },
      ],
      connection_config: config,
    });
    sandboxIds.add(recreated.id);
    const restored = await recreated.commands.run("cat persisted.txt", { workingDirectory: "/home/agent" });
    assert.equal(stdoutOf(restored).trim(), "from-sandbox");
    assert.notEqual(recreated.id, info.id);
    await recreated.destroy?.();
    sandboxIds.delete(recreated.id);
  } finally {
    if (sessionId && sandboxIds.size) {
      try {
        const connected = await sdk.Sandbox.connect(nextId(sandboxIds), { connection_config: config });
        await connected.commands.deleteSession?.(sessionId);
      } catch {
        // best-effort
      }
    }
    for (const sandboxId of sandboxIds) {
      try {
        await manager.killSandbox?.(sandboxId);
      } catch {
        // best-effort
      }
    }
    await server.stop();
  }
});

function nextId(ids: Set<string>): string {
  const id = ids.values().next().value;
  assert.ok(id);
  return id;
}
