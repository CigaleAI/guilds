import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { repoRoot } from "../../src/lib/paths.js";
import {
  RunSandboxes,
  SandboxError,
  connectionConfig,
  endpointUrl,
  metadataSecretIds,
  prepareWorkspace,
  imageFingerprint,
  sandboxKind,
  sandboxMatches,
  sandboxMetadata,
  sandboxEnvironment,
  sandboxResource,
  splitRunning,
  wrapOpenSandbox,
  browserNeedsBlankReset,
} from "../../src/sandbox/index.js";

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

test("sandbox metadata is label-safe", () => {
  const metadata = sandboxMetadata("a_1", "a".repeat(63), ["sec_1", "sec_2"]);
  assert.deepEqual(metadata, {
    agent_id: "a_1",
    environment_fingerprint: "a".repeat(63),
    browser: "0",
    coding: "0",
    kind: "lite",
    "sid.sec_1": "1",
    "sid.sec_2": "1",
  });
  for (const value of Object.values(metadata)) {
    assert.ok(value.length <= 63);
    assert.ok(/^[A-Za-z0-9]/.test(value));
    assert.ok(/[A-Za-z0-9]$/.test(value));
    assert.ok(/^[A-Za-z0-9_.-]+$/.test(value));
  }
  assert.deepEqual([...metadataSecretIds(metadata)].sort(), ["sec_1", "sec_2"]);
  assert.deepEqual([...metadataSecretIds({ secret_ids: "invalid" })], []);
});

test("prepareWorkspace creates the browser profile on a standard box", () => {
  const root = mkdtempSync(path.join(tmpdir(), "guilds-sandbox-"));
  const workspace = prepareWorkspace(root, "a_1");
  assert.equal(workspace, path.join(root, "a_1"));
  assert.equal(mkdirSync(path.join(workspace, ".browser"), { recursive: true }), undefined);
  writeFileSync(path.join(workspace, ".browser", "cookies"), "keep");
  const again = prepareWorkspace(root, "a_1", "standard");
  assert.equal(again, workspace);
  assert.equal(readFileSync(path.join(workspace, ".browser", "cookies"), "utf8"), "keep");
});

test("prepareWorkspace skips the browser profile on a lite box", () => {
  const root = mkdtempSync(path.join(tmpdir(), "guilds-sandbox-"));
  const workspace = prepareWorkspace(root, "a_lite", "lite");
  assert.equal(existsSync(path.join(workspace, "scripts")), true);
  assert.equal(existsSync(path.join(workspace, ".browser")), false);
});

test("sandbox metadata records the browser and coding flags and the box they call for", () => {
  const enabled = sandboxMetadata("a_1", "fp", [], { browser: true, coding: true });
  assert.equal(enabled.browser, "1");
  assert.equal(enabled.coding, "1");
  assert.equal(enabled.kind, "standard");
  assert.equal(enabled.browser_language, "en-US");
  assert.equal(sandboxMetadata("a_1", "fp", []).coding, "0");
  assert.equal(sandboxMetadata("a_1", "fp", []).kind, "lite");
  assert.equal(sandboxMetadata("a_1", "fp", [], { coding: true }).kind, "standard");
  assert.equal(sandboxMetadata("a_1", "fp", [], { browser: true }).kind, "standard");
  assert.equal(sandboxMetadata("a_1", "fp", []).browser_language, undefined);
  assert.equal(
    sandboxMetadata("a_1", "fp", [], { browser: true, browserLanguage: "fr-FR" }).browser_language,
    "fr-FR",
  );
});

test("a standard box is the large guest; a lite box is the small one", () => {
  assert.equal(sandboxKind({ browser: false, coding: false }), "lite");
  assert.equal(sandboxKind({ browser: true, coding: false }), "standard");
  assert.equal(sandboxKind({ browser: false, coding: true }), "standard");
  assert.equal(sandboxKind({ browser: true, coding: true }), "standard");
  assert.deepEqual(sandboxResource({ browser: true, coding: false }), { cpu: "2", memory: "4096Mi" });
  assert.deepEqual(sandboxResource({ browser: false, coding: true }), { cpu: "2", memory: "4096Mi" });
  assert.deepEqual(sandboxResource({ browser: true, coding: true }), { cpu: "2", memory: "4096Mi" });
  assert.deepEqual(sandboxResource({ browser: false, coding: false }), { cpu: "0.5", memory: "256Mi" });
});

test("each box runs its own image, and the lite box falls back to the standard image", () => {
  const root = mkdtempSync(path.join(tmpdir(), "guilds-sandbox-"));
  const both = new RunSandboxes({
    url: "http://opensandbox:8080",
    apiKey: "test",
    image: "agent-runtime:0.3",
    imageLite: "agent-runtime-lite:0.1",
    workspaceRoot: root,
  });
  assert.equal(both.imageFor({ browser: false, coding: false }), "agent-runtime-lite:0.1");
  assert.equal(both.imageFor({ browser: false, coding: true }), "agent-runtime:0.3");
  assert.equal(both.imageFor({ browser: true, coding: false }), "agent-runtime:0.3");
  const one = new RunSandboxes({
    url: "http://opensandbox:8080",
    apiKey: "test",
    image: "agent-runtime:0.3",
    workspaceRoot: root,
  });
  assert.equal(one.imageFor({ browser: false, coding: false }), "agent-runtime:0.3");
  assert.equal(
    new RunSandboxes({ url: "http://opensandbox:8080", apiKey: "test", image: "agent-runtime:0.3", imageLite: "", workspaceRoot: root })
      .imageLite,
    "agent-runtime:0.3",
  );
});

test("a sandbox from the other box's image is not the run's sandbox", () => {
  const lite = { browser: false, coding: false };
  const standard = { browser: false, coding: true };
  const onLite = sandboxMetadata("a_1", "fp", [], { image: "agent-runtime-lite:0.1" });
  assert.equal(sandboxMatches(onLite, "fp", lite, "agent-runtime-lite:0.1"), true);
  assert.equal(sandboxMatches(onLite, "fp", lite, "agent-runtime:0.3"), false, "a lite agent still on the standard image");
  assert.equal(sandboxMatches(onLite, "fp", standard, "agent-runtime:0.3"), false);
  const onStandard = sandboxMetadata("a_1", "fp", [], { coding: true, image: "agent-runtime:0.3" });
  assert.equal(onStandard.kind, "standard");
  assert.equal(sandboxMatches(onStandard, "fp", standard, "agent-runtime:0.3"), true);
  assert.equal(sandboxMatches(onStandard, "fp", lite, "agent-runtime-lite:0.1"), false);
});

test("a coding sandbox keeps HOME in the workspace", () => {
  assert.deepEqual(sandboxEnvironment({ API: "x" }, { browser: false, coding: true }), {
    API: "x",
    HOME: "/home/agent",
  });
  assert.deepEqual(sandboxEnvironment({ HOME: "/elsewhere" }, { browser: false, coding: true }).HOME, "/home/agent");
  assert.deepEqual(sandboxEnvironment({ API: "x" }, { browser: true, coding: false }), {
    API: "x",
    GUILDS_BROWSER_LANGUAGE: "en-US",
  });
  assert.deepEqual(
    sandboxEnvironment({ API: "x" }, { browser: true, coding: false, browserLanguage: "ja" }),
    { API: "x", GUILDS_BROWSER_LANGUAGE: "ja" },
  );
});

test("sandbox metadata records host_id when provided", () => {
  const metadata = sandboxMetadata("a_1", "fp", [], { hostId: "host_shared" });
  assert.equal(metadata.host_id, "host_shared");
  const without = sandboxMetadata("a_1", "fp", []);
  assert.equal(without.host_id, undefined);
});

test("sandboxMatches fingerprint, browser, coding, and language", () => {
  const off = { browser: false, coding: false };
  const browser = { browser: true, coding: false };
  const coding = { browser: false, coding: true };
  const metadata = sandboxMetadata("a_1", "fp", ["sec_1"], { browser: true });
  assert.equal(sandboxMatches(metadata, "fp", browser), true);
  assert.equal(sandboxMatches(metadata, "fp", { ...browser, browserLanguage: "fr-FR" }), false);
  assert.equal(sandboxMatches(metadata, "fp", off), false);
  assert.equal(sandboxMatches(metadata, "fp", { browser: true, coding: true }), false);
  assert.equal(sandboxMatches(metadata, "other", browser), false);
  assert.equal(sandboxMatches({ environment_fingerprint: "fp" }, "fp", browser), false);
  assert.equal(sandboxMatches({ environment_fingerprint: "fp", browser: "1" }, "fp", browser), false);
  assert.equal(sandboxMatches({ environment_fingerprint: "fp", browser: "0" }, "fp", off), true);
  assert.equal(sandboxMatches({ environment_fingerprint: "fp", browser: "0" }, "fp", coding), false);
  const coder = sandboxMetadata("a_1", "fp", [], { coding: true });
  assert.equal(sandboxMatches(coder, "fp", coding), true);
  assert.equal(sandboxMatches(coder, "fp", off), false);
});

test("a sandbox started from another image is not the run's sandbox", () => {
  const off = { browser: false, coding: false };
  const pinned = "registry.example/project/agent-runtime@sha256:" + "ab".repeat(32);
  const metadata = sandboxMetadata("a_1", "fp", [], { image: pinned });
  assert.equal(metadata.image, imageFingerprint(pinned));
  assert.match(String(metadata.image), /^[0-9a-f]{16}$/, "a label value, whatever the reference holds");
  assert.equal(sandboxMatches(metadata, "fp", off, pinned), true);
  assert.equal(sandboxMatches(metadata, "fp", off, "agent-runtime:next"), false);
  assert.equal(
    sandboxMatches(sandboxMetadata("a_1", "fp", []), "fp", off, pinned),
    false,
    "a sandbox that records no image predates the check and is replaced",
  );
  assert.equal(sandboxMatches(metadata, "fp", off), true, "no image asked for, none compared");
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
    image: "agent-runtime:0.3",
    workspaceRoot: root,
    readySeconds: 1,
    sleep: async () => undefined,
  });
  const fake = {
    id: "sbx_fake",
    commands: {
      async run(command: string) {
        if (command.includes("agent-browser.log")) {
          return {
            exit_code: 0,
            logs: { stdout: [{ text: "clearing stale chromium SingletonLock -> old-host-59" }] },
          };
        }
        if (command.includes("-w") && command.includes("6080")) {
          return { exit_code: 0, logs: { stdout: [{ text: "200" }] } };
        }
        if (command.includes("-w") && command.includes("9222")) {
          return { exit_code: 0, logs: { stdout: [{ text: "down" }] } };
        }
        return { exit_code: 1, logs: { stdout: [] } };
      },
    },
  };
  await assert.rejects(
    () => sandboxes.waitForBrowser(fake),
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
    image: "agent-runtime:0.3",
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
  await sandboxes.waitForBrowser(fake);
  assert.ok(commands.some((command) => command.includes("6080/vnc.html") && command.includes("9222/json/version")));
  assert.ok(commands.some((command) => command.includes("/json/list")));
  const navigate = commands.find((command) => command.includes("guilds-browser"));
  assert.ok(navigate);
  const blob = navigate.split(" ").pop() ?? "";
  assert.deepEqual(JSON.parse(Buffer.from(blob, "base64").toString("utf8")), { op: "navigate", url: "about:blank" });
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

test("the lite image carries the scripts launcher and the CLI, and none of the standard toolchains", () => {
  // The instructions alone: the header names what the image leaves out.
  const image = readFileSync(path.join(repoRoot(import.meta.url), "runtime/Dockerfile.lite"), "utf8")
    .split("\n")
    .filter((line) => !line.startsWith("#"))
    .join("\n");
  assert.match(image, /^FROM python:3\.12-slim$/m);
  assert.match(image, /COPY guilds-script-run \/usr\/local\/bin\/guilds-script-run/);
  assert.match(image, /COPY agent-cli-start \/usr\/local\/bin\/agent-cli-start/);
  assert.match(image, /ttyd\.x86_64/);
  assert.match(image, /WORKDIR \/home\/agent/);
  for (const absent of ["chromium", "tigervnc", "novnc", "playwright", "nodejs.org", "cli/cli", "jdx/mise", "graft", "guilds-code", "guilds-browser", "build-essential"]) {
    assert.doesNotMatch(image, new RegExp(absent, "i"), absent);
  }
});

test("ensure creates a lite agent's sandbox from the lite image and a coder's from the standard one", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "guilds-sandbox-images-"));
  const created: Array<{ image: string; resource: unknown; metadata: Record<string, string> }> = [];
  const wrapped = wrapOpenSandbox({
    SandboxManager: {
      create() {
        return {
          async listSandboxInfos() {
            return { items: [] };
          },
          async killSandbox() {
            return undefined;
          },
        };
      },
    },
    Sandbox: {
      async create(opts: unknown) {
        const body = opts as { image: string; resource: unknown; metadata: Record<string, string> };
        created.push({ image: body.image, resource: body.resource, metadata: body.metadata });
        return { id: `sbx_${created.length}`, commands: { async run() { return { exitCode: 0, logs: { stdout: [] } }; } } };
      },
      async connect() {
        throw new Error("nothing to connect to");
      },
    },
  });
  const sandboxes = new RunSandboxes({
    url: "http://opensandbox:8080",
    apiKey: "test",
    image: "agent-runtime:0.3",
    imageLite: "agent-runtime-lite:0.1",
    workspaceRoot: root,
    sdk: wrapped,
  });
  await sandboxes.start();
  await sandboxes.ensure("a_lite", {}, []);
  await sandboxes.ensure("a_coder", {}, [], { coding: true });
  assert.equal(created[0]?.image, "agent-runtime-lite:0.1");
  assert.deepEqual(created[0]?.resource, { cpu: "0.5", memory: "256Mi" });
  assert.equal(created[0]?.metadata.kind, "lite");
  assert.equal(created[0]?.metadata.image, imageFingerprint("agent-runtime-lite:0.1"));
  assert.equal(existsSync(path.join(root, "a_lite", ".browser")), false);
  assert.equal(created[1]?.image, "agent-runtime:0.3");
  assert.deepEqual(created[1]?.resource, { cpu: "2", memory: "4096Mi" });
  assert.equal(created[1]?.metadata.kind, "standard");
  assert.equal(existsSync(path.join(root, "a_coder", ".browser")), true);
  await sandboxes.close();
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

test("ensure materialises snapshotted scripts via write then move", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "guilds-sandbox-scripts-"));
  const fileCalls: Array<[string, unknown]> = [];
  const wrapped = wrapOpenSandbox({
    SandboxManager: {
      create() {
        return {
          async listSandboxInfos() {
            return { items: [] };
          },
          async killSandbox() {
            return undefined;
          },
        };
      },
    },
    Sandbox: {
      async create() {
        return {
          id: "sbx_scripts",
          commands: {
            async run() {
              return { exitCode: 0, logs: { stdout: [] } };
            },
          },
          files: {
            async writeFiles(entries: unknown) {
              fileCalls.push(["write", entries]);
            },
            async moveFiles(entries: unknown) {
              fileCalls.push(["move", entries]);
            },
            async listDirectory() {
              return [];
            },
            async deleteFiles(paths: unknown) {
              fileCalls.push(["delete", paths]);
            },
          },
        };
      },
      async connect() {
        return { id: "sbx_scripts", commands: { async run() { return { exitCode: 0, logs: { stdout: [] } }; } } };
      },
    },
  });
  const sandboxes = new RunSandboxes({
    url: "http://opensandbox:8080",
    apiKey: "test",
    image: "agent-runtime:0.3",
    workspaceRoot: root,
    sdk: wrapped,
  });
  await sandboxes.start();
  await sandboxes.ensure("a_1", {}, [], {
    scripts: [
      {
        id: "scr_1",
        name: "send_usdc",
        description: "Sign and send USDC",
        parameters: null,
        source: "print('ok')\n",
        source_hash: "abc",
      },
    ],
  });
  assert.equal(fileCalls[0]?.[0], "write");
  assert.equal(fileCalls[1]?.[0], "move");
  const writes = fileCalls[0]?.[1] as Array<{ path: string; data: string }>;
  const moves = fileCalls[1]?.[1] as Array<{ src: string; dest: string }>;
  assert.equal(writes.length, 1);
  assert.match(writes[0]?.path ?? "", /^\/home\/agent\/scripts\/\.send_usdc\.[0-9a-f]+\.tmp$/);
  assert.equal(writes[0]?.data, "print('ok')\n");
  assert.equal(moves.length, 1);
  assert.equal(moves[0]?.src, writes[0]?.path);
  assert.equal(moves[0]?.dest, "/home/agent/scripts/send_usdc.py");
  await sandboxes.close();
});
