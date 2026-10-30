import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { connectionConfig } from "../../src/sandbox/index.js";
import { openSandboxSdk, type ConnectionConfig } from "../../src/sandbox/sdk.js";

const OPENSANDBOX_COMMIT = "473ff611d93670a149ce6600f27ed194b18cce89";
const OPENSANDBOX_IMAGE = `guilds-opensandbox-server:${OPENSANDBOX_COMMIT.slice(0, 8)}`;
const OPENSANDBOX_SOURCE =
  `https://github.com/opensandbox-group/OpenSandbox.git?ref=${OPENSANDBOX_COMMIT}&subdir=server`;

export const gated =
  process.env.RUN_OPENSANDBOX_CONTRACT !== "1"
    ? "set RUN_OPENSANDBOX_CONTRACT=1 to run the Docker OpenSandbox contract"
    : false;

export function run(command: string, args: string[], check = true): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(command, args, { encoding: "utf8" });
  if (check && result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")}\n${result.stdout}\n${result.stderr}`);
  }
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

async function availablePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("no port"));
        return;
      }
      const port = address.port;
      server.close((error) => (error ? reject(error) : resolve(port)));
    });
  });
}

async function waitUntilHealthy(url: string, containerName: string): Promise<void> {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(1000) });
      if (response.status === 200) {
        return;
      }
    } catch {
      await delay(250);
    }
  }
  const logs = run("docker", ["logs", containerName], false);
  throw new Error(`OpenSandbox did not become healthy:\n${logs.stdout}\n${logs.stderr}`);
}

export function stdoutOf(execution: { logs?: { stdout?: Array<{ text?: string }> } } | null | undefined): string {
  return (execution?.logs?.stdout ?? []).map((item) => item.text ?? "").join("\n");
}


export type OpenSandboxServer = {
  config: ConnectionConfig;
  sdk: Awaited<ReturnType<typeof openSandboxSdk>>;
  manager: Awaited<ReturnType<Awaited<ReturnType<typeof openSandboxSdk>>["SandboxManager"]["create"]>>;
  workspaceRoot: string;
  url: string;
  apiKey: string;
  stop(): Promise<void>;
};

/** A throwaway OpenSandbox server at the pinned commit, on a free port, with its own store. */
export async function startOpenSandboxServer(): Promise<OpenSandboxServer> {
  const root = mkdtempSync(path.join(tmpdir(), "guilds-opensandbox-"));
  const workspaceRoot = path.join(root, "workspaces");
  const dataRoot = path.join(root, "data");
  mkdirSync(workspaceRoot);
  mkdirSync(dataRoot);
  const configPath = path.join(root, "opensandbox.toml");
  writeFileSync(
    configPath,
    `
[server]
host = "0.0.0.0"
port = 8080

[proxy]
resolve_internal = false

[log]
level = "INFO"

[runtime]
type = "docker"
execd_image = "opensandbox/execd:v1.1.0"

[egress]
image = "opensandbox/egress:v1.1.7"
readiness_timeout_seconds = 30.0

[docker]
network_mode = "bridge"
host_ip = "host.docker.internal"
port_range_min = 40000
port_range_max = 60000
drop_capabilities = [
  "AUDIT_WRITE",
  "MKNOD",
  "NET_ADMIN",
  "NET_RAW",
  "SYS_ADMIN",
  "SYS_MODULE",
  "SYS_PTRACE",
  "SYS_TIME",
  "SYS_TTY_CONFIG",
]
no_new_privileges = true
pids_limit = 4096

[ingress]
mode = "direct"

[storage]
allowed_host_paths = [${JSON.stringify(workspaceRoot)}]

[store]
type = "sqlite"
path = "/data/opensandbox.db"
`.trim() + "\n",
  );

  if (run("docker", ["image", "inspect", OPENSANDBOX_IMAGE], false).status !== 0) {
    run("docker", ["build", "--tag", OPENSANDBOX_IMAGE, OPENSANDBOX_SOURCE]);
  }

  const port = await availablePort();
  const apiKey = "guilds-contract-key";
  const containerName = `guilds-opensandbox-contract-${process.pid}`;
  run("docker", [
    "run",
    "--detach",
    "--name",
    containerName,
    "--add-host",
    "host.docker.internal:host-gateway",
    "--publish",
    `127.0.0.1:${port}:8080`,
    "--env",
    `OPENSANDBOX_SERVER_API_KEY=${apiKey}`,
    "--volume",
    "/var/run/docker.sock:/var/run/docker.sock",
    "--volume",
    `${configPath}:/etc/opensandbox/config.toml:ro`,
    "--volume",
    `${dataRoot}:/data`,
    "--volume",
    `${workspaceRoot}:${workspaceRoot}`,
    OPENSANDBOX_IMAGE,
    "--config",
    "/etc/opensandbox/config.toml",
  ]);

  const config = connectionConfig(`http://127.0.0.1:${port}`, apiKey);
  const sdk = await openSandboxSdk();
  const manager = await Promise.resolve(sdk.SandboxManager.create(config));
  const stop = async () => {
    await manager.close?.();
    run("docker", ["rm", "--force", containerName], false);
  };
  try {
    await waitUntilHealthy(`http://127.0.0.1:${port}/health`, containerName);
  } catch (error) {
    await stop();
    throw error;
  }
  return { config, sdk, manager, workspaceRoot, url: `http://127.0.0.1:${port}`, apiKey, stop };
}
