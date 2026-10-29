import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { repoRoot } from "../../src/lib/paths.js";
import { agentDirectory, slotPorts } from "../../src/machines/index.js";
import {
  RunSandboxes,
  SandboxError,
  agentSandbox,
  applyRunScripts,
  connectionConfig,
  endpointUrl,
  imageFingerprint,
  machineMatches,
  machineMetadata,
  machineResource,
  machineSpec,
  prepareBrowserWorkspace,
  prepareWorkspace,
  seatEnvironment,
  splitRunning,
  wrapOpenSandbox,
  browserNeedsBlankReset,
  type AgentSeat,
  type MachineSpec,
} from "../../src/sandbox/index.js";

const STANDARD: MachineSpec = { id: "mach_1", orgId: "org_1", box: "standard", cpu: 1, memoryMib: 2048 };
const SEAT: AgentSeat = { agentId: "a_1", machineId: "mach_1", slot: 2, browserLanguage: "fr-FR" };

test("connectionConfig parses a compose URL", () => {
  const config = connectionConfig("http://opensandbox:8080", "guilds-dev");
  assert.equal(config.domain, "opensandbox:8080");
  assert.equal(config.protocol, "http");
  assert.equal(config.apiKey, "guilds-dev");
  assert.equal(config.useServerProxy, true);
  assert.equal(config.requestTimeoutSeconds, 180);
  assert.equal(config.disableMetrics, true);
});

test("splitRunning keeps the earliest sandbox", () => {
  const later = { id: "late", created_at: new Date("2026-09-10T12:00:00Z") };
  const earlier = { id: "early", created_at: new Date("2026-09-10T11:00:00Z") };
  const [keeper, extras] = splitRunning([later, earlier]);
  assert.equal(keeper?.id, "early");
  assert.deepEqual(extras.map((item) => item.id), ["late"]);
});

test("splitRunning empty", () => {
  const [keeper, extras] = splitRunning([]);
  assert.equal(keeper, null);
  assert.deepEqual(extras, []);
});

test("machine metadata is label-safe and names the machine, its tier, and its size", () => {
  const metadata = machineMetadata(STANDARD, { hostId: "host_shared", image: "agent-runtime:0.4" });
  assert.deepEqual(metadata, {
    machine_id: "mach_1",
    kind: "standard",
    cpu: "1",
    memory: "2048Mi",
    host_id: "host_shared",
    image: imageFingerprint("agent-runtime:0.4"),
  });
  for (const value of Object.values(metadata)) {
    assert.ok(value.length <= 63);
    assert.ok(/^[A-Za-z0-9_.-]+$/.test(value));
  }
  assert.equal(machineMetadata(STANDARD).host_id, undefined);
  assert.equal("agent_id" in metadata, false, "no agent, secret, or flag labels");
});

test("a machine row runs at its tier's size, a custom one at its own", () => {
  assert.deepEqual(machineSpec({ id: "m", org_id: "o", box: "code", cpu: null, memory_mib: null }), {
    id: "m",
    orgId: "o",
    box: "code",
    cpu: 2,
    memoryMib: 4096,
  });
  const custom = machineSpec({ id: "m", org_id: "o", box: "custom", cpu: 1.5, memory_mib: 3072 });
  assert.deepEqual(machineResource(custom), { cpu: "1.5", memory: "3072Mi" });
  assert.deepEqual(machineResource(STANDARD), { cpu: "1", memory: "2048Mi" });
});

test("a container of another tier, size, or image is not the machine's", () => {
  const pinned = "registry.example/project/agent-runtime@sha256:" + "ab".repeat(32);
  const metadata = machineMetadata(STANDARD, { image: pinned });
  assert.match(String(metadata.image), /^[0-9a-f]{16}$/, "a label value, whatever the reference holds");
  assert.equal(machineMatches(metadata, STANDARD, pinned), true);
  assert.equal(machineMatches(metadata, STANDARD), true, "no image asked for, none compared");
  assert.equal(machineMatches(metadata, STANDARD, "agent-runtime:next"), false);
  assert.equal(machineMatches(metadata, { ...STANDARD, box: "code", cpu: 2, memoryMib: 4096 }, pinned), false);
  // A standard machine and a custom one of the same size are different tiers.
  assert.equal(machineMatches(metadata, { ...STANDARD, box: "custom" }, pinned), false);
  assert.equal(machineMatches(metadata, { ...STANDARD, memoryMib: 4096 }, pinned), false);
  assert.equal(machineMatches({ kind: "standard" }, STANDARD), false);
  assert.equal(machineMatches(null, STANDARD), false);
});

test("prepareBrowserWorkspace lays the agent's home out in its machine's directory and keeps its profile", () => {
  const root = mkdtempSync(path.join(tmpdir(), "guilds-sandbox-"));
  const home = prepareBrowserWorkspace(root, "mach_1", "a_1");
  assert.equal(home, path.join(root, "mach_1", "a_1"));
  assert.equal(home, agentDirectory(root, "mach_1", "a_1"));
  writeFileSync(path.join(home, ".browser", "cookies"), "keep");
  assert.equal(prepareBrowserWorkspace(root, "mach_1", "a_1"), home);
  assert.equal(readFileSync(path.join(home, ".browser", "cookies"), "utf8"), "keep");
});

test("prepareWorkspace lays the agent's home out without a browser profile", () => {
  const root = mkdtempSync(path.join(tmpdir(), "guilds-sandbox-"));
  const plain = prepareWorkspace(root, "mach_1", "a_2");
  assert.equal(plain, agentDirectory(root, "mach_1", "a_2"));
  assert.equal(existsSync(path.join(plain, "scripts")), true);
  assert.equal(existsSync(path.join(plain, ".browser")), false);
});

test("an agent's commands carry its home, its port block, and what the call adds", async () => {
  assert.deepEqual(seatEnvironment(SEAT), {
    HOME: "/home/a_1",
    GUILDS_AGENT_HOME: "/home/a_1",
    PORT: String(slotPorts(2).portsFrom),
    GUILDS_PORTS: `${slotPorts(2).portsFrom}-${slotPorts(2).portsTo}`,
  });
  const calls: Array<[string, Record<string, unknown>]> = [];
  const machine = {
    id: "sbx_1",
    commands: {
      async run(command: string, opts?: Record<string, unknown>) {
        calls.push([command, opts ?? {}]);
        return { exit_code: 0 };
      },
    },
  };
  const view = agentSandbox(machine, "/home/a_1", { ...seatEnvironment(SEAT), API_KEY: "secret" });
  await view.commands.run("ls", { timeoutSeconds: 5 });
  await view.commands.run("pwd", { workingDirectory: "/home/a_1/repos/site", envs: { EXTRA: "1", API_KEY: "call" } });
  assert.equal(calls[0]?.[1].workingDirectory, "/home/a_1");
  assert.deepEqual(calls[0]?.[1].envs, { ...seatEnvironment(SEAT), API_KEY: "secret" });
  assert.equal(calls[1]?.[1].workingDirectory, "/home/a_1/repos/site");
  assert.deepEqual(calls[1]?.[1].envs, { ...seatEnvironment(SEAT), API_KEY: "call", EXTRA: "1" });
});

test("endpointUrl adds a scheme", () => {
  assert.equal(endpointUrl({ endpoint: "opensandbox:8080/proxy/1/6080" }), "http://opensandbox:8080/proxy/1/6080");
  assert.equal(endpointUrl({ endpoint: "https://host/vnc/" }), "https://host/vnc");
});

test("browserNeedsBlankReset detects the hosted origin and Chrome error pages", () => {
  assert.equal(browserNeedsBlankReset("[]"), false);
  assert.equal(browserNeedsBlankReset('[{"url":"about:blank","title":""}]'), false);
  assert.equal(browserNeedsBlankReset('[{"url":"https://example.com/","title":"Example"}]'), false);
  assert.equal(browserNeedsBlankReset('[{"url":"https://guilds.run/","title":"guilds.run"}]'), true);
  assert.equal(
    browserNeedsBlankReset('[{"url":"chrome-error://chromewebdata/","title":"guilds.run refused to connect"}]'),
    true,
  );
});

test("waitForBrowser includes the start log", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "guilds-sandbox-"));
  const sandboxes = new RunSandboxes({
    url: "http://opensandbox:8080",
    apiKey: "test",
    image: "agent-runtime:0.4",
    workspaceRoot: root,
    readySeconds: 1,
    sleep: async () => undefined,
  });
  const fake = {
    id: "sbx_fake",
    commands: {
      async run(command: string) {
        if (command.includes("/run/guilds/a_1/browser.log")) {
          return {
            exit_code: 0,
            logs: { stdout: [{ text: "clearing stale chromium SingletonLock -> old-host-59" }] },
          };
        }
        if (command.includes("-w") && command.includes(String(slotPorts(2).novnc))) {
          return { exit_code: 0, logs: { stdout: [{ text: "200" }] } };
        }
        if (command.includes("-w") && command.includes(String(slotPorts(2).cdp))) {
          return { exit_code: 0, logs: { stdout: [{ text: "down" }] } };
        }
        return { exit_code: 1, logs: { stdout: [] } };
      },
    },
  };
  await assert.rejects(
    () => sandboxes.waitForBrowser(fake, SEAT),
    (error: unknown) => {
      assert.ok(error instanceof SandboxError);
      assert.match(error.message, /browser session failed to start/);
      assert.match(error.message, /vnc=200/);
      assert.match(error.message, /cdp=down/);
      assert.match(error.message, /clearing stale chromium SingletonLock -> old-host-59/);
      return true;
    },
  );
});

test("waitForBrowser navigates off guilds.run onto about:blank", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "guilds-sandbox-"));
  const sandboxes = new RunSandboxes({
    url: "http://opensandbox:8080",
    apiKey: "test",
    image: "agent-runtime:0.4",
    workspaceRoot: root,
    readySeconds: 1,
    sleep: async () => undefined,
  });
  const commands: string[] = [];
  const fake = {
    id: "sbx_fake",
    commands: {
      async run(command: string) {
        commands.push(command);
        if (command.includes("/json/list")) {
          return {
            exit_code: 0,
            logs: { stdout: [{ text: '[{"url":"https://guilds.run/","title":"guilds.run"}]' }] },
          };
        }
        return { exit_code: 0, logs: { stdout: [] } };
      },
    },
  };
  await sandboxes.waitForBrowser(fake, SEAT);
  const ports = slotPorts(2);
  assert.ok(
    commands.some((command) => command.includes(`${ports.novnc}/vnc.html`) && command.includes(`${ports.cdp}/json/version`)),
  );
  assert.ok(commands.some((command) => command.includes(`${ports.cdp}/json/list`)));
  const navigate = commands.find((command) => command.includes("guilds-browser"));
  assert.ok(navigate);
  const blob = navigate.split(" ").pop() ?? "";
  assert.deepEqual(JSON.parse(Buffer.from(blob, "base64").toString("utf8")), {
    op: "navigate",
    url: "about:blank",
    cdp_port: ports.cdp,
  });
});

test("wrapOpenSandbox maps JS SDK signatures onto the Python-used surface", async () => {
  const calls: unknown[] = [];
  const wrapped = wrapOpenSandbox({
    SandboxManager: {
      create(opts: unknown) {
        calls.push(["manager", opts]);
        return {
          async listSandboxInfos(filter: unknown) {
            calls.push(["list", filter]);
            return { items: [{ id: "sbx_1", createdAt: new Date("2026-09-10T11:00:00Z") }] };
          },
          async killSandbox(id: string) {
            calls.push(["kill", id]);
          },
          async getSandboxInfo(id: string) {
            return { id, expiresAt: null, createdAt: new Date("2026-09-10T11:00:00Z") };
          },
        };
      },
    },
    Sandbox: {
      async create(opts: unknown) {
        calls.push(["create", opts]);
        return {
          id: "sbx_1",
          commands: {
            async run(command: string, runOpts?: unknown, handlers?: { onInit?: (init: { id: string }) => void }) {
              calls.push(["run", command, runOpts]);
              await handlers?.onInit?.({ id: "exec_1" });
              return { id: "exec_1", exitCode: 0, logs: { stdout: [{ text: "ok" }] } };
            },
            async createSession(opts?: { workingDirectory?: string }) {
              calls.push(["session", opts]);
              return "sess_1";
            },
          },
          async getEndpoint(port: number) {
            return { endpoint: `opensandbox:8080/proxy/1/${port}`, headers: { "x-test": "1" } };
          },
          async kill() {
            calls.push(["destroy"]);
          },
        };
      },
      async connect(opts: unknown) {
        calls.push(["connect", opts]);
        return { id: "sbx_1", commands: { async run() { return { exitCode: 0, logs: { stdout: [] } }; } } };
      },
    },
  });
  const config = connectionConfig("http://opensandbox:8080", "guilds-dev");
  const manager = await Promise.resolve(wrapped.SandboxManager.create(config));
  const info = await manager.getSandboxInfo!("sbx_1");
  assert.equal(info.expires_at, null);
  await manager.listSandboxInfos!({ states: ["Running"], metadata: { run_id: "r_1" }, page_size: 50 });
  const sandbox = await wrapped.Sandbox.create("python:3.12-slim", {
    timeout: null,
    metadata: { run_id: "r_1" },
    resource: { cpu: "1", memory: "512Mi" },
    volumes: [{ name: "workspace", host: { path: "/tmp/ws" }, mount_path: "/home/agent", read_only: false }],
    connection_config: config,
  });
  let initId = "";
  const result = await sandbox.commands.run("echo ok", {
    working_directory: "/home/agent",
    on_init: (init: { id: string }) => {
      initId = init.id;
    },
  } as never);
  assert.equal(initId, "exec_1");
  assert.equal(result.exitCode ?? result.exit_code, 0);
  assert.equal(await sandbox.commands.createSession!("/home/agent"), "sess_1");
  const endpoint = await sandbox.getEndpoint!(6080);
  assert.equal(endpoint.endpoint, "opensandbox:8080/proxy/1/6080");
  assert.deepEqual(endpoint.build_request_headers?.(config), { "x-test": "1" });
  await sandbox.destroy?.();
  await wrapped.Sandbox.connect("sbx_1", { connection_config: config });
  const createCall = calls.find((item) => Array.isArray(item) && item[0] === "create") as [string, Record<string, unknown>];
  assert.equal(createCall[1].image, "python:3.12-slim");
  assert.equal(createCall[1].timeoutSeconds, null);
  assert.deepEqual((createCall[1].volumes as Array<Record<string, unknown>>)[0]?.mountPath, "/home/agent");
  const managerCall = calls.find((item) => Array.isArray(item) && item[0] === "manager") as [string, Record<string, unknown>];
  assert.equal((managerCall[1].connectionConfig as { useServerProxy?: boolean }).useServerProxy, true);
  const connectCall = calls.find((item) => Array.isArray(item) && item[0] === "connect") as [string, Record<string, unknown>];
  assert.equal(connectCall[1].sandboxId, "sbx_1");
});

test("runtime desktop is HD", () => {
  const text = readFileSync(path.join(repoRoot(import.meta.url), "runtime/agent-browser-start"), "utf8");
  assert.match(text, /GEOMETRY="\$\{BROWSER_GEOMETRY:-1280x720\}"/);
  assert.match(text, /-AcceptSetDesktopSize=0/);
  assert.match(text, /--window-size=1280,720/);
});

test("runtime installs regular Chrome not Chrome for Testing", () => {
  const text = readFileSync(path.join(repoRoot(import.meta.url), "runtime/install-chrome.py"), "utf8");
  assert.match(text, /google-chrome-stable_current_amd64\.deb/);
  assert.match(text, /official Google Chrome is not published; using Debian chromium/);
  assert.doesNotMatch(text, /chrome-for-testing/);
  assert.doesNotMatch(text, /last-known-good-versions-with-downloads/);
});

test("runtime launches desktop Chrome with PC-like flags", () => {
  const text = readFileSync(path.join(repoRoot(import.meta.url), "runtime/agent-browser-start"), "utf8");
  assert.match(text, /google-chrome/);
  assert.match(text, /guilds-locale --write-profile/);
  assert.match(text, /--no-sandbox/);
  assert.match(text, /--use-angle=swiftshader/);
  assert.match(text, /--enable-unsafe-swiftshader/);
  // Software compositing: SwiftShader stays for WebGL contexts only.
  assert.match(text, /--disable-gpu-compositing/);
  assert.match(text, /--disable-blink-features=AutomationControlled/);
  assert.match(text, /--lang="\$\{CHROME_LANG:-en-US\}"/);
  assert.match(text, /--accept-lang="\$\{CHROME_ACCEPT_LANG:-en-US,en\}"/);
  assert.doesNotMatch(text, /--disable-gpu(?![\w-])/);
  assert.doesNotMatch(text, /--disable-software-rasterizer/);
  assert.doesNotMatch(text, /--test-type/);
});

test("ensure runs one container per machine, at its size, with its directory at /home", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "guilds-sandbox-images-"));
  const created: Array<Record<string, unknown>> = [];
  const killed: string[] = [];
  let listed: Array<Record<string, unknown>> = [];
  const wrapped = wrapOpenSandbox({
    SandboxManager: {
      create() {
        return {
          async listSandboxInfos() {
            return { items: listed };
          },
          async killSandbox(id: string) {
            killed.push(id);
          },
        };
      },
    },
    Sandbox: {
      async create(opts: unknown) {
        created.push(opts as Record<string, unknown>);
        return { id: `sbx_${created.length}`, commands: { async run() { return { exitCode: 0, logs: { stdout: [] } }; } } };
      },
      async connect(opts: unknown) {
        return { id: String((opts as { sandboxId: string }).sandboxId), commands: { async run() { return { exitCode: 0 }; } } };
      },
    },
  });
  const sandboxes = new RunSandboxes({
    url: "http://opensandbox:8080",
    apiKey: "test",
    image: "agent-runtime:0.4",
    workspaceRoot: root,
    sdk: wrapped,
  });
  await sandboxes.start();
  const custom: MachineSpec = { id: "mach_2", orgId: "org_1", box: "custom", cpu: 3, memoryMib: 6144 };
  await sandboxes.ensure(STANDARD);
  await sandboxes.ensure(custom);
  assert.equal(created[0]?.image, "agent-runtime:0.4");
  assert.deepEqual(created[0]?.resource, { cpu: "1", memory: "2048Mi" });
  assert.equal((created[0]?.metadata as Record<string, string>).machine_id, "mach_1");
  assert.equal(created[0]?.env, undefined, "no secret reaches the container's environment");
  assert.equal(created[0]?.entrypoint, undefined);
  const volume = (created[0]?.volumes as Array<Record<string, unknown>>)[0];
  assert.equal(volume?.mountPath, "/home");
  assert.deepEqual(volume?.host, { path: path.join(root, "mach_1") });
  assert.equal(existsSync(path.join(root, "mach_1")), true);
  assert.deepEqual(created[1]?.resource, { cpu: "3", memory: "6144Mi" });
  // A running container of the machine's size is kept; one of another size is replaced.
  listed = [{ id: "sbx_live", metadata: machineMetadata(STANDARD, { image: "agent-runtime:0.4" }) }];
  const kept = await sandboxes.ensure(STANDARD);
  assert.equal(kept.id, "sbx_live");
  assert.equal(created.length, 2);
  await sandboxes.ensure({ ...STANDARD, box: "code", cpu: 2, memoryMib: 4096 });
  assert.deepEqual(killed, ["sbx_live"]);
  assert.equal(created.length, 3);
  await sandboxes.close();
});

test("destroyAgentSandboxes kills the sandboxes that ran one agent, and no machine", async () => {
  const killed: string[] = [];
  const wrapped = wrapOpenSandbox({
    SandboxManager: {
      create() {
        return {
          async listSandboxInfos() {
            return {
              items: [
                { id: "sbx_agent", metadata: { agent_id: "a_1", kind: "lite" } },
                { id: "sbx_machine", metadata: { machine_id: "mach_1" } },
              ],
            };
          },
          async killSandbox(id: string) {
            killed.push(id);
          },
        };
      },
    },
    Sandbox: {
      async create() {
        throw new Error("no create");
      },
      async connect() {
        throw new Error("no connect");
      },
    },
  });
  const sandboxes = new RunSandboxes({
    url: "http://opensandbox:8080",
    apiKey: "test",
    image: "agent-runtime:0.4",
    workspaceRoot: mkdtempSync(path.join(tmpdir(), "guilds-sandbox-")),
    sdk: wrapped,
  });
  await sandboxes.start();
  assert.equal(await sandboxes.destroyAgentSandboxes(), 1);
  assert.deepEqual(killed, ["sbx_agent"]);
  assert.deepEqual([...(await sandboxes.listRunningMachineIds())], ["mach_1"]);
});

test("each agent's browser starts and stops on its own slot", async () => {
  const commands: string[] = [];
  const sandboxes = new RunSandboxes({
    url: "http://opensandbox:8080",
    apiKey: "test",
    image: "agent-runtime:0.4",
    workspaceRoot: mkdtempSync(path.join(tmpdir(), "guilds-sandbox-")),
    readySeconds: 1,
    sleep: async () => undefined,
  });
  const fake = {
    id: "sbx_fake",
    commands: {
      async run(command: string) {
        commands.push(command);
        return { exit_code: 0, logs: { stdout: [{ text: "[]" }] } };
      },
    },
  };
  await sandboxes.startBrowser(fake, SEAT);
  await sandboxes.stopBrowser(fake, SEAT);
  await sandboxes.purgeAgent(fake, SEAT);
  const ports = slotPorts(2);
  assert.equal(
    commands[0],
    `/usr/local/bin/agent-browser-start a_1 ${ports.display} ${ports.vnc} ${ports.cdp} ${ports.novnc} fr-FR`,
  );
  assert.ok(commands.includes("/usr/local/bin/agent-stop a_1 browser"));
  assert.ok(commands.includes("/usr/local/bin/agent-stop a_1 purge"));
  const [base] = await sandboxes.novncTarget(
    { ...fake, getEndpoint: async (port: number) => ({ endpoint: `host/route/${port}` }) },
    SEAT,
  );
  assert.equal(base, `http://host/route/${slotPorts(2).novnc}`);
});

test("stopping an agent whose processes outlive the stop fails", async () => {
  const sandboxes = new RunSandboxes({
    url: "http://opensandbox:8080",
    apiKey: "test",
    image: "agent-runtime:0.4",
    workspaceRoot: mkdtempSync(path.join(tmpdir(), "guilds-sandbox-")),
  });
  const stuck = {
    id: "sbx_stuck",
    commands: {
      async run() {
        return { exit_code: 1, logs: { stdout: [] } };
      },
    },
  };
  await assert.rejects(() => sandboxes.purgeAgent(stuck, SEAT), SandboxError);
  await assert.rejects(() => sandboxes.stopBrowser(stuck, SEAT), SandboxError);
});

/** The runtime's agent scripts laid out as in the image: helpers in bin, their library in lib/guilds. */
function runtimeScripts(): string {
  const root = mkdtempSync(path.join(tmpdir(), "guilds-runtime-"));
  const runtime = path.join(repoRoot(import.meta.url), "runtime");
  mkdirSync(path.join(root, "bin"));
  mkdirSync(path.join(root, "lib", "guilds"), { recursive: true });
  for (const name of ["agent-browser-start", "agent-cli-start", "agent-stop"]) {
    copyFileSync(path.join(runtime, name), path.join(root, "bin", name));
  }
  copyFileSync(path.join(runtime, "agent-lib.sh"), path.join(root, "lib", "guilds", "agent-lib.sh"));
  return root;
}

function bash(args: string[]): { status: number | null; stderr: string } {
  const result = spawnSync("bash", args, { encoding: "utf8", timeout: 10_000 });
  return { status: result.status, stderr: result.stderr };
}

test("the agent helpers refuse a malformed agent id, port, display, or mode before touching anything", () => {
  const root = runtimeScripts();
  const bin = (name: string) => path.join(root, "bin", name);
  const ports = slotPorts(2);
  const browser = [String(ports.display), String(ports.vnc), String(ports.cdp), String(ports.novnc)];
  const refused = [
    [bin("agent-browser-start"), "../a_1", ...browser, "fr-FR"],
    [bin("agent-browser-start"), "a_1", "0", String(ports.vnc), String(ports.cdp), String(ports.novnc), "fr-FR"],
    [bin("agent-browser-start"), "a_1", String(ports.display), "80", String(ports.cdp), String(ports.novnc), "fr-FR"],
    [bin("agent-browser-start"), "a_1", ...browser, "fr FR"],
    [bin("agent-browser-start"), "a_1", "2", "fr-FR"],
    [bin("agent-cli-start"), "a 1", String(ports.ttyd), String(ports.portsFrom), String(ports.portsTo)],
    [bin("agent-cli-start"), "a_1", "70000", String(ports.portsFrom), String(ports.portsTo)],
    [bin("agent-cli-start"), "a_1", String(ports.ttyd), String(ports.portsTo), String(ports.portsFrom)],
    [bin("agent-cli-start"), "a_1", "2"],
    [bin("agent-stop"), "a/1", "all"],
    [bin("agent-stop"), "a_1", "everything"],
  ];
  for (const args of refused) {
    const result = bash(args);
    assert.equal(result.status, 2, args.join(" "));
    assert.match(result.stderr, /^usage: /, args.join(" "));
  }
});

test("the agent library validates ports and displays and waits a bounded time", () => {
  const library = path.join(runtimeScripts(), "lib", "guilds", "agent-lib.sh");
  const check = (body: string) => bash(["-c", `source "$0"; ${body}`, library]).status;
  assert.equal(check("valid_port 1024 && valid_port 65535 && valid_port 08080"), 0);
  assert.equal(check("valid_port 1023"), 1);
  assert.equal(check("valid_port 65536"), 1);
  assert.equal(check("valid_port 70x"), 1);
  assert.equal(check("valid_display 10 && valid_display 41"), 0);
  assert.equal(check("valid_display 0"), 1);
  assert.equal(check("valid_agent a_1-B && ! valid_agent ../a && ! valid_agent ''"), 0);
  assert.equal(check("n=0; bump() { n=$((n + 1)); [ $n -ge 3 ]; }; wait_until 10 bump && [ $n = 3 ]"), 0);
  assert.equal(check("wait_until 2 false"), 1);
});

test("the agent library ends a whole process group and reports one that is gone", { skip: process.platform !== "linux" }, () => {
  const library = path.join(runtimeScripts(), "lib", "guilds", "agent-lib.sh");
  const script =
    'source "$0"; setsid bash -c "sleep 60 & sleep 60" & leader=$!; '
    + "wait_until 20 group_alive $leader || exit 3; stop_group $leader || exit 4; "
    + "group_alive $leader && exit 5; stop_group $leader";
  assert.equal(bash(["-c", script, library]).status, 0);
});

test("runtime hides the --no-sandbox infobar and ships Chromium language packs", () => {
  const image = readFileSync(path.join(repoRoot(import.meta.url), "runtime/Dockerfile"), "utf8");
  assert.match(image, /chromium-l10n/);
  assert.match(image, /CommandLineFlagSecurityWarningsEnabled/);
  assert.match(image, /HomepageLocation": "about:blank/);
  assert.match(image, /RestoreOnStartup": 4/);
  assert.match(image, /\/etc\/chromium\/policies\/managed/);
  assert.match(image, /\/etc\/opt\/chrome\/policies\/managed/);
});

test("runtime clears stale chromium locks", () => {
  const text = readFileSync(path.join(repoRoot(import.meta.url), "runtime/agent-browser-start"), "utf8");
  assert.match(text, /clear_stale_chromium_locks/);
  assert.match(text, /SingletonLock/);
  assert.match(text, /SingletonCookie/);
  assert.match(text, /SingletonSocket/);
  assert.match(text, /chromium exited \$\?/);
});

test("runtime opens Chrome on about:blank instead of restoring the last URL", () => {
  const text = readFileSync(path.join(repoRoot(import.meta.url), "runtime/agent-browser-start"), "utf8");
  assert.match(text, /clear_restored_tabs/);
  assert.match(text, /--homepage=about:blank/);
  assert.match(text, /^\s+about:blank$/m);
});

test("applyRunScripts materialises snapshotted scripts in the agent's home via write then move", async () => {
  const fileCalls: Array<[string, unknown]> = [];
  const sandbox = {
    id: "sbx_scripts",
    commands: {
      async run() {
        return { exitCode: 0, logs: { stdout: [] } };
      },
    },
    files: {
      async writeFiles(entries: Array<{ path: string; data?: string | Uint8Array | ArrayBuffer }>) {
        fileCalls.push(["write", entries]);
      },
      async moveFiles(entries: Array<{ src: string; dest: string }>) {
        fileCalls.push(["move", entries]);
      },
      async listDirectory() {
        return [];
      },
      async deleteFiles(paths: string[]) {
        fileCalls.push(["delete", paths]);
      },
    },
  };
  await applyRunScripts(sandbox, "/home/a_1", [
    {
      id: "scr_1",
      name: "send_usdc",
      description: "Sign and send USDC",
      parameters: null,
      source: "print('ok')\n",
      source_hash: "abc",
    },
  ]);
  assert.equal(fileCalls[0]?.[0], "write");
  assert.equal(fileCalls[1]?.[0], "move");
  const writes = fileCalls[0]?.[1] as Array<{ path: string; data: string }>;
  const moves = fileCalls[1]?.[1] as Array<{ src: string; dest: string }>;
  assert.equal(writes.length, 1);
  assert.match(writes[0]?.path ?? "", /^\/home\/a_1\/scripts\/\.send_usdc\.[0-9a-f]+\.tmp$/);
  assert.equal(writes[0]?.data, "print('ok')\n");
  assert.equal(moves.length, 1);
  assert.equal(moves[0]?.src, writes[0]?.path);
  assert.equal(moves[0]?.dest, "/home/a_1/scripts/send_usdc.py");
});
