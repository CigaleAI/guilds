import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { HARNESS_LIST, isHarness } from "../coding/harnesses.js";
import type { Harness } from "../db/schema/index.js";
import { agentHome } from "../lib/agent-file.js";
import { writeLog } from "../observability/log.js";
import { agentDirectory, machineDirectory, machineSize, slotPorts, type MachineBox, type SlotPorts } from "../machines/index.js";
import { SCRIPTS_DIR } from "../scripts/validation.js";
import { materialiseScripts } from "../scripts/materialise.js";
import type { RunScriptSnapshot } from "../db/schema/index.js";
import {
  openSandboxSdk,
  SandboxError,
  type CommandResult,
  type ConnectionConfig,
  type ListMatches,
  type OpenSandboxModule,
  type SandboxCommands,
  type SandboxEndpoint,
  type SandboxHandle,
  type SandboxInfo,
  type SandboxManagerHandle,
} from "./sdk.js";

export const BROWSER_PROFILE = ".browser";
export const BROWSER_START = "/usr/local/bin/agent-browser-start";
export const AGENT_STOP = "/usr/local/bin/agent-stop";
export const BROWSER_READY_SECONDS = 60;
export const CLI_ENTRYPOINT = "/usr/local/bin/agent-cli-start";
export const CLI_START_SECONDS = 20;
/** Where the machine's directory is mounted: every agent's home is a folder in it. */
export const MACHINE_MOUNT = "/home";
/** The in-container directory of an agent's runtime files: git tokens, process ids, logs. */
export const AGENT_RUN_ROOT = "/run/guilds";
const CLI_TOKEN_RE = /^[0-9a-f]{48}$/;
const HOST_HOME_RE = /guilds\.run|chrome-error:\/\//i;

function blankNavigate(cdpPort: number): string {
  const spec = { op: "navigate", url: "about:blank", cdp_port: cdpPort };
  return `python3 /usr/local/bin/guilds-browser ${Buffer.from(JSON.stringify(spec)).toString("base64")}`;
}

export function browserNeedsBlankReset(pagesJson: string): boolean {
  let pages: unknown;
  try {
    pages = JSON.parse(pagesJson);
  } catch {
    return HOST_HOME_RE.test(pagesJson);
  }
  const list = Array.isArray(pages) ? pages : [pages];
  return list.some((page) => {
    if (!page || typeof page !== "object") {
      return false;
    }
    const record = page as { url?: unknown; title?: unknown };
    return HOST_HOME_RE.test(String(record.url ?? "")) || HOST_HOME_RE.test(String(record.title ?? ""));
  });
}


/** An agent's runtime files in its machine: `/run/guilds/<agent id>`. */
export function agentRunDir(agentId: string): string {
  return `${AGENT_RUN_ROOT}/${agentId}`;
}

/** The agent's home with its scripts directory. */
export function prepareWorkspace(workspaceRoot: string, machineId: string, agentId: string): string {
  const workspace = agentDirectory(workspaceRoot, machineId, agentId);
  mkdirSync(path.join(workspace, SCRIPTS_DIR), { recursive: true });
  return workspace;
}

/** The home of an agent with a browser: its scripts directory and its browser profile. */
export function prepareBrowserWorkspace(workspaceRoot: string, machineId: string, agentId: string): string {
  const workspace = prepareWorkspace(workspaceRoot, machineId, agentId);
  mkdirSync(path.join(workspace, BROWSER_PROFILE), { recursive: true });
  return workspace;
}

export async function applyRunScripts(
  sandbox: SandboxHandle,
  home: string,
  snapshot: RunScriptSnapshot[] = [],
  liveExtra: Array<{ name: unknown; source: unknown } | Record<string, unknown>> = [],
): Promise<void> {
  const files = sandbox.files;
  if (!files) {
    return;
  }
  await materialiseScripts(files, home, snapshot, liveExtra as Array<{ name: unknown; source: unknown }>);
}

/** The machine a container runs: its id, organisation, tier, and size. */
export type MachineSpec = {
  id: string;
  orgId: string;
  box: MachineBox;
  cpu: number;
  memoryMib: number;
};

/** A machine row as the container it runs. */
export function machineSpec(machine: {
  id: string;
  org_id: string;
  box: MachineBox;
  cpu: number | null;
  memory_mib: number | null;
}): MachineSpec {
  const size = machineSize(machine);
  return { id: machine.id, orgId: machine.org_id, box: machine.box, cpu: size.cpu, memoryMib: size.memory_mib };
}

/** An agent's seat on its machine: its slot, which sets its display and ports, and Chrome's language. */
export type AgentSeat = {
  agentId: string;
  machineId: string;
  slot: number;
  browserLanguage: string;
};

/** The ports a seat's slot sets. */
export function seatPorts(seat: AgentSeat): SlotPorts {
  return slotPorts(seat.slot);
}

/**
 * The environment every command run for an agent carries, without its secrets: its home as
 * `HOME`, and its port block.
 */
export function seatEnvironment(seat: AgentSeat): Record<string, string> {
  const home = agentHome(seat.agentId);
  const ports = slotPorts(seat.slot);
  return {
    HOME: home,
    GUILDS_AGENT_HOME: home,
    PORT: String(ports.portsFrom),
    GUILDS_PORTS: `${ports.portsFrom}-${ports.portsTo}`,
  };
}

/**
 * The machine's sandbox as one agent sees it: every command runs in the agent's home, with the
 * agent's environment under whatever the call adds. Files and interrupts are the machine's.
 */
export function agentSandbox(sandbox: SandboxHandle, home: string, envs: Record<string, string>): SandboxHandle {
  const commands: SandboxCommands = {
    run: async (command, opts, handlers) => {
      const body = (opts ?? {}) as Record<string, unknown>;
      const extra = (body.envs ?? body.env) as Record<string, string> | undefined;
      const merged: Record<string, unknown> = { ...body, envs: { ...envs, ...(extra ?? {}) } };
      delete merged.env;
      if (merged.workingDirectory === undefined && merged.working_directory === undefined) {
        merged.workingDirectory = home;
        merged.working_directory = home;
      }
      return sandbox.commands.run(command, merged as never, handlers);
    },
  };
  if (sandbox.commands.interrupt) {
    commands.interrupt = sandbox.commands.interrupt.bind(sandbox.commands);
  }
  if (sandbox.commands.getCommandStatus) {
    commands.getCommandStatus = sandbox.commands.getCommandStatus.bind(sandbox.commands);
  }
  const view: SandboxHandle = { id: sandbox.id, commands };
  if (sandbox.files) {
    view.files = sandbox.files;
  }
  return view;
}

export function connectionConfig(url: string, apiKey: string): ConnectionConfig {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new SandboxError("OPENSANDBOX_URL must include a host");
  }
  if (!parsed.host) {
    throw new SandboxError("OPENSANDBOX_URL must include a host");
  }
  return {
    domain: parsed.host,
    protocol: parsed.protocol.replace(/:$/, "") || "http",
    apiKey,
    requestTimeoutSeconds: 180,
    useServerProxy: true,
    disableMetrics: true,
  };
}

function createdStamp(item: SandboxInfo): number {
  const raw = item.created_at ?? item.createdAt;
  if (raw instanceof Date) {
    return raw.getTime();
  }
  if (typeof raw === "number" && Number.isFinite(raw)) {
    return raw;
  }
  if (typeof raw === "string") {
    const parsed = Date.parse(raw);
    return Number.isNaN(parsed) ? 0 : parsed;
  }
  return 0;
}

export function splitRunning(infos: SandboxInfo[]): [SandboxInfo | null, SandboxInfo[]] {
  if (!infos.length) {
    return [null, []];
  }
  const ordered = [...infos].sort((left, right) => createdStamp(left) - createdStamp(right));
  return [ordered[0] ?? null, ordered.slice(1)];
}

/** An image reference as a label value: references are too long, and hold characters labels refuse. */
export function imageFingerprint(image: string): string {
  return createHash("sha256").update(image).digest("hex").slice(0, 16);
}

/** The labels a machine's container carries. */
export function machineMetadata(
  machine: MachineSpec,
  options: { hostId?: string | undefined; image?: string } = {},
): Record<string, string> {
  const resource = machineResource(machine);
  const metadata: Record<string, string> = {
    machine_id: machine.id,
    kind: machine.box,
    cpu: resource.cpu,
    memory: resource.memory,
  };
  if (options.hostId) {
    metadata.host_id = options.hostId;
  }
  if (options.image) {
    metadata.image = imageFingerprint(options.image);
  }
  return metadata;
}

/** What a sandbox is created with, as OpenSandbox takes it: CPUs and memory with a `Mi` suffix. */
export type SandboxResource = { cpu: string; memory: string };

export function machineResource(machine: Pick<MachineSpec, "cpu" | "memoryMib">): SandboxResource {
  return { cpu: String(machine.cpu), memory: `${machine.memoryMib}Mi` };
}

/**
 * Whether a running container is the one this machine would create: the same tier and size, and
 * with `image`, the same image, since the helpers the tools call are part of it.
 */
export function machineMatches(metadata: unknown, machine: MachineSpec, image?: string): boolean {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    return false;
  }
  const body = metadata as Record<string, unknown>;
  if (image !== undefined && body.image !== imageFingerprint(image)) {
    return false;
  }
  const resource = machineResource(machine);
  return body.kind === machine.box && body.cpu === resource.cpu && body.memory === resource.memory;
}

export function endpointUrl(endpoint: { endpoint: string }): string {
  let raw = endpoint.endpoint.trim();
  if (!raw.includes("://")) {
    raw = `http://${raw}`;
  }
  return raw.replace(/\/+$/, "");
}

export function requestHeaders(endpoint: SandboxEndpoint, config: ConnectionConfig): Record<string, string> {
  if (typeof endpoint.build_request_headers === "function") {
    return endpoint.build_request_headers(config);
  }
  if (typeof endpoint.buildRequestHeaders === "function") {
    return endpoint.buildRequestHeaders(config);
  }
  return { ...(endpoint.headers ?? {}) };
}

function infosOf(matches: ListMatches | null | undefined): SandboxInfo[] {
  if (!matches) {
    return [];
  }
  const list = matches.sandbox_infos ?? matches.sandboxInfos ?? matches.items ?? [];
  return Array.isArray(list) ? list : [];
}

async function listInfos(manager: SandboxManagerHandle, filter: Record<string, unknown>): Promise<SandboxInfo[]> {
  const listed = manager.listSandboxInfos ?? manager.list_sandbox_infos;
  if (!listed) {
    throw new SandboxError("sandbox manager cannot list sandboxes");
  }
  return infosOf(await listed.call(manager, filter));
}

async function killSandbox(manager: SandboxManagerHandle, id: string): Promise<void> {
  const kill = manager.killSandbox ?? manager.kill_sandbox;
  if (!kill) {
    throw new SandboxError("sandbox manager cannot kill sandboxes");
  }
  await kill.call(manager, id);
}

function stdoutText(execution: CommandResult | null | undefined): string {
  const messages = execution?.logs?.stdout ?? [];
  return messages.map((item) => item.text ?? "").join("\n").trim();
}

function exitCode(execution: CommandResult | null | undefined): number | undefined {
  return execution?.exit_code ?? execution?.exitCode;
}


async function loadOpenSandbox(): Promise<OpenSandboxModule> {
  return openSandboxSdk();
}

export class RunSandboxes {
  /** The image every machine runs: Chromium and the coding toolchains. */
  image: string;
  workspaceRoot: string;
  hostId: string | undefined;
  private config: ConnectionConfig;
  private manager: SandboxManagerHandle | null = null;
  private sdk: OpenSandboxModule | null;
  private sleep: (ms: number) => Promise<void>;
  private readySeconds: number;
  /** The harness CLIs of each container this process created, by machine. */
  private carried = new Map<string, Harness[]>();

  constructor(options: {
    url: string;
    apiKey: string;
    image: string;
    workspaceRoot: string;
    hostId?: string | undefined;
    sdk?: OpenSandboxModule | undefined;
    sleep?: ((ms: number) => Promise<void>) | undefined;
    readySeconds?: number | undefined;
  }) {
    this.image = options.image;
    this.workspaceRoot = options.workspaceRoot;
    this.hostId = options.hostId;
    this.config = connectionConfig(options.url, options.apiKey);
    this.sdk = options.sdk ?? null;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.readySeconds = options.readySeconds ?? BROWSER_READY_SECONDS;
  }

  private async module(): Promise<OpenSandboxModule> {
    if (this.sdk) {
      return this.sdk;
    }
    this.sdk = await loadOpenSandbox();
    return this.sdk;
  }

  async start(): Promise<void> {
    const sdk = await this.module();
    this.manager = await Promise.resolve(sdk.SandboxManager.create(this.config));
  }

  async close(): Promise<void> {
    if (this.manager?.close) {
      await this.manager.close();
    }
    this.manager = null;
  }

  private requireManager(): SandboxManagerHandle {
    if (this.manager === null) {
      throw new SandboxError("sandbox manager is not started");
    }
    return this.manager;
  }

  private async connect(id: string): Promise<SandboxHandle> {
    const sdk = await this.module();
    return sdk.Sandbox.connect(id, { connectionConfig: this.config, connection_config: this.config });
  }

  /**
   * The machine's running container, created when there is none. A container of another tier,
   * size, or image is replaced; the machine's directory, and every home in it, stays.
   */
  async ensure(machine: MachineSpec): Promise<SandboxHandle> {
    const manager = this.requireManager();
    const sdk = await this.module();
    const matches = await listInfos(manager, {
      states: ["Running"],
      metadata: { machine_id: machine.id },
      pageSize: 100,
    });
    const [first, extras] = splitRunning(matches);
    let keeper = first;
    for (const extra of extras) {
      await killSandbox(manager, extra.id);
    }
    if (keeper !== null && !machineMatches(keeper.metadata, machine, this.image)) {
      await killSandbox(manager, keeper.id);
      keeper = null;
    }
    if (keeper !== null) {
      return this.connect(keeper.id);
    }
    const directory = machineDirectory(this.workspaceRoot, machine.id);
    mkdirSync(directory, { recursive: true });
    const created = await sdk.Sandbox.create(this.image, {
      timeout: null,
      timeoutSeconds: null,
      metadata: machineMetadata(machine, { hostId: this.hostId, image: this.image }),
      resource: machineResource(machine),
      volumes: [
        {
          name: "machine",
          host: { path: directory },
          mount_path: MACHINE_MOUNT,
          mountPath: MACHINE_MOUNT,
          read_only: false,
          readOnly: false,
        },
      ],
      connection_config: this.config,
      connectionConfig: this.config,
    });
    await this.readHarnesses(machine.id, created);
    return created;
  }

  /** The harness CLIs a new container's image lists; an image without the list carries none. */
  private async readHarnesses(machineId: string, sandbox: SandboxHandle): Promise<void> {
    try {
      const execution = await sandbox.commands.run(`cat ${HARNESS_LIST} 2>/dev/null || true`, { timeoutSeconds: 10 });
      const listed = (execution.logs?.stdout ?? []).map((message) => message.text ?? "").join("\n");
      this.carried.set(machineId, [...new Set(listed.split(/\s+/).filter(isHarness))]);
    } catch (error) {
      writeLog("warn", error instanceof Error ? error.message : String(error), {
        operation: "machine.harnesses",
        machine_id: machineId,
      });
    }
  }

  /** The harness CLIs the container this process last created for the machine carries. */
  harnessesOf(machineId: string): Harness[] | null {
    return this.carried.get(machineId) ?? null;
  }

  async connectRunning(machineId: string): Promise<SandboxHandle | null> {
    const manager = this.requireManager();
    const matches = await listInfos(manager, {
      states: ["Running"],
      metadata: { machine_id: machineId },
      pageSize: 100,
    });
    const [keeper] = splitRunning(matches);
    return keeper === null ? null : this.connect(keeper.id);
  }

  /** Starts the agent's display, Chrome, and noVNC when they are not up, and waits until they answer. */
  async startBrowser(sandbox: SandboxHandle, seat: AgentSeat): Promise<void> {
    const ports = seatPorts(seat);
    const command =
      `${BROWSER_START} ${seat.agentId} ${ports.display} ${ports.vnc} ${ports.cdp} ${ports.novnc} `
      + seat.browserLanguage;
    try {
      await sandbox.commands.run(command, { timeoutSeconds: this.readySeconds + 5 });
    } catch {
      /* the wait below reports why the browser is not answering */
    }
    await this.waitForBrowser(sandbox, seat);
  }

  /** Stops the agent's Chrome, display, and noVNC. Its profile and logins stay in its home. */
  async stopBrowser(sandbox: SandboxHandle, seat: AgentSeat): Promise<void> {
    await this.runStop(sandbox, seat, "browser");
  }

  /**
   * Stops every process the agent has on its machine, its browser, its terminal, and its
   * background commands, and removes its runtime files under /run/guilds. Throws when a process
   * outlives the stop, since it would still hold the slot's ports.
   */
  async purgeAgent(sandbox: SandboxHandle, seat: AgentSeat): Promise<void> {
    await this.runStop(sandbox, seat, "purge");
  }

  private async runStop(sandbox: SandboxHandle, seat: AgentSeat, mode: "browser" | "purge"): Promise<void> {
    const result = await sandbox.commands.run(`${AGENT_STOP} ${seat.agentId} ${mode}`, { timeoutSeconds: 30 });
    const code = exitCode(result);
    if (code !== undefined && code !== 0) {
      throw new SandboxError(`agent ${seat.agentId} processes did not stop (${mode}, exit ${code})`);
    }
  }

  async novncTarget(sandbox: SandboxHandle, seat: AgentSeat): Promise<[string, Record<string, string>]> {
    if (!sandbox.getEndpoint) {
      throw new SandboxError("sandbox cannot resolve endpoints");
    }
    const endpoint = await sandbox.getEndpoint(seatPorts(seat).novnc);
    return [endpointUrl(endpoint), requestHeaders(endpoint, this.config)];
  }

  /**
   * Starts the agent's terminal daemon when it is not already answering and returns the secret
   * path segment it serves under. The helper is idempotent, so a second call on a live daemon
   * returns the same secret.
   */
  async startCli(sandbox: SandboxHandle, seat: AgentSeat): Promise<string> {
    let result: CommandResult;
    try {
      const ports = seatPorts(seat);
      const command = `${CLI_ENTRYPOINT} ${seat.agentId} ${ports.ttyd} ${ports.portsFrom} ${ports.portsTo}`;
      result = await sandbox.commands.run(command, {
        timeoutSeconds: CLI_START_SECONDS,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new SandboxError(`terminal failed to start: ${message}`);
    }
    const lines = stdoutText(result).split("\n");
    const token = (lines[lines.length - 1] ?? "").trim();
    if (exitCode(result) !== 0 || !CLI_TOKEN_RE.test(token)) {
      throw new SandboxError("terminal failed to start");
    }
    return token;
  }

  /**
   * The terminal's upstream base, the port's endpoint plus the daemon's secret path, and the
   * host's headers. The sandbox host's proxy drops `Authorization`, so the secret travels in the
   * path instead.
   */
  async cliTarget(sandbox: SandboxHandle, seat: AgentSeat, token: string): Promise<[string, Record<string, string>]> {
    if (!sandbox.getEndpoint) {
      throw new SandboxError("sandbox cannot resolve endpoints");
    }
    const endpoint = await sandbox.getEndpoint(seatPorts(seat).ttyd);
    return [`${endpointUrl(endpoint)}/t/${token}`, requestHeaders(endpoint, this.config)];
  }

  async waitForBrowser(sandbox: SandboxHandle, seat: AgentSeat): Promise<void> {
    const ports = seatPorts(seat);
    const command =
      `curl -sf -o /dev/null http://127.0.0.1:${ports.novnc}/vnc.html `
      + `&& curl -sf -o /dev/null http://127.0.0.1:${ports.cdp}/json/version`;
    for (let attempt = 0; attempt < this.readySeconds; attempt += 1) {
      let result: CommandResult | null;
      try {
        result = await sandbox.commands.run(command, { timeoutSeconds: 5 });
      } catch {
        result = null;
      }
      if (result !== null && exitCode(result) === 0) {
        await this.resetHostHomePage(sandbox, ports.cdp);
        return;
      }
      await this.sleep(1000);
    }
    const detail = await this.browserFailureDetail(sandbox, seat);
    let message = "browser session failed to start";
    if (detail) {
      message = `${message}\n${detail}`;
    }
    throw new SandboxError(message);
  }

  private async resetHostHomePage(sandbox: SandboxHandle, cdpPort: number): Promise<void> {
    const pages = await this.runText(sandbox, `curl -sf http://127.0.0.1:${cdpPort}/json/list || true`);
    if (!browserNeedsBlankReset(pages)) {
      return;
    }
    try {
      await sandbox.commands.run(blankNavigate(cdpPort), { timeoutSeconds: 20 });
    } catch {
      /* error page is still visible in noVNC; do not fail pane open */
    }
  }

  private async browserFailureDetail(sandbox: SandboxHandle, seat: AgentSeat): Promise<string> {
    const ports = seatPorts(seat);
    const vnc = await this.runText(
      sandbox,
      `curl -sf -o /dev/null -w '%{http_code}' http://127.0.0.1:${ports.novnc}/vnc.html || echo down`,
    );
    const cdp = await this.runText(
      sandbox,
      `curl -sf -o /dev/null -w '%{http_code}' http://127.0.0.1:${ports.cdp}/json/version || echo down`,
    );
    const log = await this.runText(sandbox, `tail -n 80 ${agentRunDir(seat.agentId)}/browser.log || true`);
    const parts = [`vnc=${vnc || "down"}`, `cdp=${cdp || "down"}`];
    if (log) {
      parts.push(log);
    }
    return parts.join("\n");
  }

  private async runText(sandbox: SandboxHandle, command: string): Promise<string> {
    try {
      const result = await sandbox.commands.run(command, { timeoutSeconds: 5 });
      return stdoutText(result);
    } catch {
      return "";
    }
  }

  async listRunningMachineIds(): Promise<Set<string>> {
    const manager = this.requireManager();
    const matches = await listInfos(manager, { states: ["Running"], pageSize: 100 });
    const machineIds = new Set<string>();
    for (const info of matches) {
      const metadata = info.metadata;
      if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
        continue;
      }
      const machineId = (metadata as { machine_id?: unknown }).machine_id;
      if (typeof machineId === "string") {
        machineIds.add(machineId);
      }
    }
    return machineIds;
  }

  async destroy(machineId: string): Promise<void> {
    const manager = this.requireManager();
    const matches = await listInfos(manager, { metadata: { machine_id: machineId }, pageSize: 100 });
    for (const info of matches) {
      await killSandbox(manager, info.id);
    }
  }

  /** Destroys every sandbox that runs one agent alone, labelled with `agent_id`. */
  async destroyAgentSandboxes(): Promise<number> {
    const manager = this.requireManager();
    let count = 0;
    for (const info of await listInfos(manager, { pageSize: 100 })) {
      const metadata = info.metadata;
      if (metadata && typeof metadata === "object" && !Array.isArray(metadata) && "agent_id" in metadata) {
        await killSandbox(manager, info.id);
        count += 1;
      }
    }
    return count;
  }
}
