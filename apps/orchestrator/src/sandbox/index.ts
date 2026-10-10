import { createHash } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { boxForFlags, DEFAULT_BROWSER_LANGUAGE, type Box, type CustomSize } from "../agents/validation.js";
import { environmentFingerprint } from "../credentials/crypto.js";
import { AGENT_HOME } from "../lib/agent-file.js";
import { orchestratorRoot } from "../lib/paths.js";
import { SCRIPTS_DIR } from "../scripts/validation.js";
import { materialiseScripts } from "../scripts/materialise.js";
import type { RunScriptSnapshot } from "../scripts/snapshot.js";

export const BROWSER_PROFILE = ".browser";
export const BROWSER_ENTRYPOINT = ["/usr/local/bin/agent-browser-start"];
export const BROWSER_NOVNC_PORT = 6080;
export const BROWSER_READY_SECONDS = 60;
export const BROWSER_START_LOG = "/tmp/agent-browser.log";
export const CLI_PORT = 7681;
export const CLI_ENTRYPOINT = "/usr/local/bin/agent-cli-start";
export const CLI_START_SECONDS = 20;
const CLI_TOKEN_RE = /^[0-9a-f]{48}$/;
/** Size of a lite box: scripts, notes, MCP, and the CLI. */
export const LITE_SANDBOX_MEMORY_MIB = 256;
export const LITE_SANDBOX_CPU = "0.5";
/** Size of a standard box: Chromium, and the browser tools. */
export const STANDARD_SANDBOX_MEMORY_MIB = 2048;
export const STANDARD_SANDBOX_CPU = "1";
/** Size of a code box: Chromium and the coding toolchains. */
export const CODE_SANDBOX_MEMORY_MIB = 4096;
export const CODE_SANDBOX_CPU = "2";
const HOST_HOME_RE = /guilds\.run|chrome-error:\/\//i;
const BLANK_NAVIGATE = `python3 /usr/local/bin/guilds-browser ${Buffer.from(JSON.stringify({ op: "navigate", url: "about:blank" })).toString("base64")}`;

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

export class SandboxError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SandboxError";
  }
}

export type ConnectionConfig = {
  domain: string;
  protocol: string;
  apiKey: string;
  requestTimeoutSeconds: number;
  useServerProxy: boolean;
  disableMetrics: boolean;
};

type SandboxInfo = {
  id: string;
  created_at?: Date | string | number;
  createdAt?: Date | string | number;
  metadata?: unknown;
};

type SandboxEndpoint = {
  endpoint: string;
  headers?: Record<string, string>;
  build_request_headers?: (config: ConnectionConfig) => Record<string, string>;
  buildRequestHeaders?: (config: ConnectionConfig) => Record<string, string>;
};

type CommandResult = {
  id?: string;
  exit_code?: number;
  exitCode?: number;
  logs?: { stdout?: Array<{ text?: string }> };
};

type SandboxCommands = {
  run(
    command: string,
    opts?: { timeoutSeconds?: number; timeout?: number; workingDirectory?: string; background?: boolean },
    handlers?: unknown,
  ): Promise<CommandResult>;
  createSession?(workingDirectory?: string | { workingDirectory?: string; working_directory?: string }): Promise<string>;
  runInSession?(sessionId: string, command: string): Promise<CommandResult>;
  deleteSession?(sessionId: string): Promise<void>;
  interrupt?(executionId: string): Promise<void>;
  getCommandStatus?(executionId: string): Promise<{ running?: boolean }>;
};

export type SandboxHandle = {
  id: string;
  commands: SandboxCommands;
  files?: SandboxFiles;
  getEndpoint?(port: number): Promise<SandboxEndpoint>;
  close?(): Promise<void>;
  destroy?(): Promise<void>;
};

type SandboxFiles = {
  writeFiles(entries: Array<{ path: string; data?: string | Uint8Array | ArrayBuffer }>): Promise<void>;
  moveFiles(entries: Array<{ src: string; dest: string }>): Promise<void>;
  listDirectory?(entry: { path: string; depth?: number }): Promise<Array<{ path: string; type?: string }>>;
  deleteFiles(paths: string[]): Promise<void>;
  write_files?(entries: Array<{ path: string; data?: string | Uint8Array | ArrayBuffer }>): Promise<void>;
  move_files?(entries: Array<{ src: string; dest: string }>): Promise<void>;
  list_directory?(entry: { path: string; depth?: number }): Promise<Array<{ path: string; type?: string }>>;
  delete_files?(paths: string[]): Promise<void>;
};

type ListMatches = {
  sandbox_infos?: SandboxInfo[];
  sandboxInfos?: SandboxInfo[];
  items?: SandboxInfo[];
};

type SandboxManagerHandle = {
  listSandboxInfos?(filter: Record<string, unknown>): Promise<ListMatches>;
  list_sandbox_infos?(filter: Record<string, unknown>): Promise<ListMatches>;
  killSandbox?(id: string): Promise<void>;
  kill_sandbox?(id: string): Promise<void>;
  getSandboxInfo?(id: string): Promise<{
    id: string;
    expires_at?: unknown;
    expiresAt?: unknown;
    created_at?: Date | string | number;
    createdAt?: Date | string | number;
  }>;
  close?(): Promise<void>;
};

type OpenSandboxModule = {
  SandboxManager: {
    create(config: ConnectionConfig): SandboxManagerHandle | Promise<SandboxManagerHandle>;
  };
  Sandbox: {
    create(image: string, options: Record<string, unknown>): Promise<SandboxHandle>;
    connect(id: string, options: Record<string, unknown>): Promise<SandboxHandle>;
  };
};

/** The agent's workspace with its scripts directory, and the browser profile on every box but lite. */
export function prepareWorkspace(workspaceRoot: string, agentId: string, box: Box = "standard"): string {
  const workspace = path.join(workspaceRoot, agentId);
  if (box !== "lite") {
    mkdirSync(path.join(workspace, BROWSER_PROFILE), { recursive: true });
  }
  mkdirSync(path.join(workspace, SCRIPTS_DIR), { recursive: true });
  return workspace;
}

export async function applyRunScripts(
  sandbox: SandboxHandle,
  snapshot: RunScriptSnapshot[] = [],
  liveExtra: Array<{ name: unknown; source: unknown } | Record<string, unknown>> = [],
): Promise<void> {
  const files = sandbox.files;
  if (!files) {
    return;
  }
  await materialiseScripts(files, snapshot, liveExtra as Array<{ name: unknown; source: unknown }>);
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

export function metadataSecretIds(metadata: unknown): Set<string> {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    return new Set();
  }
  const ids = new Set<string>();
  for (const [key, value] of Object.entries(metadata as Record<string, unknown>)) {
    if (key.startsWith("sid.") && value === "1") {
      ids.add(key.slice(4));
    }
  }
  return ids;
}

/** An image reference as a label value: references are too long, and hold characters labels refuse. */
export function imageFingerprint(image: string): string {
  return createHash("sha256").update(image).digest("hex").slice(0, 16);
}

export function sandboxMetadata(
  agentId: string,
  fingerprint: string,
  secretIds: string[],
  options: {
    box?: Box;
    browser?: boolean;
    coding?: boolean;
    browserLanguage?: string;
    size?: CustomSize | null | undefined;
    hostId?: string | undefined;
    image?: string;
  } = {},
): Record<string, string> {
  const flags = sandboxFlags(options);
  const resource = sandboxResource(flags);
  const metadata: Record<string, string> = {
    agent_id: agentId,
    environment_fingerprint: fingerprint,
    browser: flags.browser ? "1" : "0",
    coding: flags.coding ? "1" : "0",
    kind: flags.box,
    cpu: resource.cpu,
    memory: resource.memory,
  };
  if (flags.browser) {
    metadata.browser_language = flags.browserLanguage ?? DEFAULT_BROWSER_LANGUAGE;
  }
  if (options.hostId) {
    metadata.host_id = options.hostId;
  }
  if (options.image) {
    metadata.image = imageFingerprint(options.image);
  }
  for (const secretId of secretIds) {
    metadata[`sid.${secretId}`] = "1";
  }
  return metadata;
}

/**
 * What decides the sandbox an agent runs in: its box, the browser and coding flags, Chrome's
 * language, and on a custom box its size.
 */
export type SandboxFlags = {
  box: Box;
  browser: boolean;
  coding: boolean;
  browserLanguage?: string;
  size?: CustomSize | null | undefined;
};

/** The flags from an options bag; a missing box is the one the flags call for. */
export function sandboxFlags(options: {
  box?: Box;
  browser?: boolean;
  coding?: boolean;
  browserLanguage?: string;
  size?: CustomSize | null | undefined;
}): SandboxFlags {
  const browser = options.browser ?? false;
  const coding = options.coding ?? false;
  return {
    box: options.box ?? boxForFlags({ browser, coding }),
    browser,
    coding,
    browserLanguage: options.browserLanguage ?? DEFAULT_BROWSER_LANGUAGE,
    size: options.size ?? null,
  };
}

/** What a sandbox is created with, as OpenSandbox takes it: CPUs and memory with a `Mi` suffix. */
export type SandboxResource = { cpu: string; memory: string };

const SANDBOX_RESOURCES: Record<Exclude<Box, "custom">, SandboxResource> = {
  lite: { cpu: LITE_SANDBOX_CPU, memory: `${LITE_SANDBOX_MEMORY_MIB}Mi` },
  standard: { cpu: STANDARD_SANDBOX_CPU, memory: `${STANDARD_SANDBOX_MEMORY_MIB}Mi` },
  code: { cpu: CODE_SANDBOX_CPU, memory: `${CODE_SANDBOX_MEMORY_MIB}Mi` },
};

/** The CPU and memory the box gets: its tier's, or on a custom box the operator's size. */
export function sandboxResource(flags: SandboxFlags): SandboxResource {
  if (flags.box === "custom") {
    if (!flags.size) {
      throw new SandboxError("a custom box needs cpu and memory_mib");
    }
    return { cpu: String(flags.size.cpu), memory: `${flags.size.memory_mib}Mi` };
  }
  return { ...SANDBOX_RESOURCES[flags.box] };
}

/**
 * Whether a running sandbox is the one this run would create: the same box and size, the same
 * flags and language. With `image`, a sandbox started from another image is not: the helpers the
 * tools call are part of the image.
 */
export function sandboxMatches(
  metadata: unknown,
  fingerprint: string,
  flags: SandboxFlags,
  image?: string,
): boolean {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    return false;
  }
  const body = metadata as Record<string, unknown>;
  if (body.environment_fingerprint !== fingerprint) {
    return false;
  }
  if (image !== undefined && body.image !== imageFingerprint(image)) {
    return false;
  }
  if (body.kind !== flags.box) {
    return false;
  }
  const resource = sandboxResource(flags);
  if (body.cpu !== resource.cpu || body.memory !== resource.memory) {
    return false;
  }
  if ((body.browser === "1") !== flags.browser || (body.coding === "1") !== flags.coding) {
    return false;
  }
  if (flags.browser) {
    const expected = flags.browserLanguage ?? DEFAULT_BROWSER_LANGUAGE;
    if (body.browser_language !== expected) {
      return false;
    }
  }
  return true;
}

/**
 * The container environment: the agent's secrets, plus `HOME` in the workspace on a coding
 * sandbox so package caches, toolchains, and git configuration persist across idle stops.
 */
export function sandboxEnvironment(secrets: Record<string, string>, flags: SandboxFlags): Record<string, string> {
  const env: Record<string, string> = flags.coding ? { ...secrets, HOME: AGENT_HOME } : { ...secrets };
  if (flags.browser) {
    env.GUILDS_BROWSER_LANGUAGE = flags.browserLanguage ?? DEFAULT_BROWSER_LANGUAGE;
  }
  return env;
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

export type RawSdk = {
  SandboxManager: { create: (opts?: unknown) => unknown };
  Sandbox: {
    create: (opts: unknown) => Promise<unknown>;
    connect: (opts: unknown) => Promise<unknown>;
  };
};

function connectionOf(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return value;
  }
  const body = value as Record<string, unknown>;
  return body.connectionConfig ?? body.connection_config ?? value;
}

function normalizeVolumes(value: unknown): unknown {
  if (!Array.isArray(value)) {
    return value;
  }
  return value.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      return item;
    }
    const volume = item as Record<string, unknown>;
    return {
      ...volume,
      mountPath: volume.mountPath ?? volume.mount_path,
      readOnly: volume.readOnly ?? volume.read_only ?? false,
    };
  });
}

function commandOpts(opts: unknown): Record<string, unknown> | undefined {
  if (!opts || typeof opts !== "object" || Array.isArray(opts)) {
    return undefined;
  }
  const body = opts as Record<string, unknown>;
  const timeout = body.timeoutSeconds ?? body.timeout;
  const out: Record<string, unknown> = {};
  const workingDirectory = body.workingDirectory ?? body.working_directory;
  if (workingDirectory !== undefined) {
    out.workingDirectory = workingDirectory;
  }
  if (body.background !== undefined) {
    out.background = body.background;
  }
  if (typeof timeout === "number") {
    out.timeoutSeconds = timeout;
  }
  const envs = body.envs ?? body.env;
  if (envs !== undefined) {
    out.envs = envs;
  }
  return out;
}

function commandHandlers(opts: unknown, handlers: unknown): unknown {
  const fromOpts =
    opts && typeof opts === "object" && !Array.isArray(opts)
      ? (opts as { onInit?: unknown; on_init?: unknown })
      : {};
  const fromHandlers =
    handlers && typeof handlers === "object" && !Array.isArray(handlers)
      ? (handlers as { onInit?: unknown; on_init?: unknown })
      : {};
  const onInit = fromHandlers.onInit ?? fromHandlers.on_init ?? fromOpts.onInit ?? fromOpts.on_init;
  if (!onInit && handlers) {
    return handlers;
  }
  if (!onInit) {
    return undefined;
  }
  return { ...(typeof handlers === "object" && handlers ? handlers : {}), onInit };
}

function wrapCommands(commands: SandboxCommands): SandboxCommands {
  const wrapped: SandboxCommands = {
    run: async (command, opts, handlers) => {
      const run = commands.run.bind(commands);
      return run(command, commandOpts(opts) as never, commandHandlers(opts, handlers) as never);
    },
  };
  if (commands.createSession) {
    wrapped.createSession = async (workingDirectory) => {
      const create = commands.createSession!.bind(commands);
      if (typeof workingDirectory === "string") {
        return create({ workingDirectory } as never);
      }
      const body =
        workingDirectory && typeof workingDirectory === "object"
          ? (workingDirectory as { workingDirectory?: string; working_directory?: string })
          : {};
      const directory = body.workingDirectory ?? body.working_directory;
      return create((directory ? { workingDirectory: directory } : workingDirectory) as never);
    };
  }
  if (commands.runInSession) {
    wrapped.runInSession = commands.runInSession.bind(commands);
  }
  if (commands.deleteSession) {
    wrapped.deleteSession = commands.deleteSession.bind(commands);
  }
  if (commands.interrupt) {
    wrapped.interrupt = commands.interrupt.bind(commands);
  }
  if (commands.getCommandStatus) {
    wrapped.getCommandStatus = commands.getCommandStatus.bind(commands);
  }
  return wrapped;
}

function wrapFiles(files: SandboxFiles): SandboxFiles {
  const write = files.writeFiles ?? files.write_files;
  const move = files.moveFiles ?? files.move_files;
  const list = files.listDirectory ?? files.list_directory;
  const remove = files.deleteFiles ?? files.delete_files;
  const wrapped: SandboxFiles = {
    writeFiles: async (entries) => {
      if (!write) {
        throw new SandboxError("sandbox files API cannot write");
      }
      await write.call(files, entries);
    },
    moveFiles: async (entries) => {
      if (!move) {
        throw new SandboxError("sandbox files API cannot move");
      }
      await move.call(files, entries);
    },
    deleteFiles: async (paths) => {
      if (!remove) {
        throw new SandboxError("sandbox files API cannot delete");
      }
      await remove.call(files, paths);
    },
  };
  if (list) {
    wrapped.listDirectory = async (entry) => list.call(files, entry);
  }
  wrapped.write_files = wrapped.writeFiles;
  wrapped.move_files = wrapped.moveFiles;
  wrapped.delete_files = wrapped.deleteFiles;
  if (wrapped.listDirectory) {
    wrapped.list_directory = wrapped.listDirectory;
  }
  return wrapped;
}

function wrapHandle(sandbox: SandboxHandle & { kill?: () => Promise<void>; files?: SandboxFiles }): SandboxHandle {
  const handle: SandboxHandle = {
    id: sandbox.id,
    commands: wrapCommands(sandbox.commands),
  };
  if (sandbox.files) {
    handle.files = wrapFiles(sandbox.files);
  }
  if (sandbox.getEndpoint) {
    handle.getEndpoint = async (port: number) => {
      const endpoint = await sandbox.getEndpoint!(port);
      const headers = () => ({ ...(endpoint.headers ?? {}) });
      return {
        ...endpoint,
        build_request_headers: headers,
        buildRequestHeaders: headers,
      };
    };
  }
  if (sandbox.close) {
    handle.close = sandbox.close.bind(sandbox);
  }
  const destroy = sandbox.destroy ?? sandbox.kill;
  if (destroy) {
    handle.destroy = destroy.bind(sandbox);
  }
  return handle;
}

function wrapManager(manager: SandboxManagerHandle): SandboxManagerHandle {
  const list = manager.listSandboxInfos ?? manager.list_sandbox_infos;
  const kill = manager.killSandbox ?? manager.kill_sandbox;
  const getInfo = manager.getSandboxInfo;
  const listSandboxInfos = async (filter: Record<string, unknown>) => {
    if (!list) {
      throw new SandboxError("sandbox manager cannot list sandboxes");
    }
    const body = filter as { pageSize?: unknown; page_size?: unknown };
    return list.call(manager, {
      ...filter,
      pageSize: body.pageSize ?? body.page_size ?? 100,
    });
  };
  const killSandbox = async (id: string) => {
    if (!kill) {
      throw new SandboxError("sandbox manager cannot kill sandboxes");
    }
    await kill.call(manager, id);
  };
  const wrapped: SandboxManagerHandle = {
    listSandboxInfos,
    killSandbox,
    list_sandbox_infos: listSandboxInfos,
    kill_sandbox: killSandbox,
  };
  if (manager.close) {
    wrapped.close = manager.close.bind(manager);
  }
  if (getInfo) {
    wrapped.getSandboxInfo = async (id: string) => {
      const info = await getInfo.call(manager, id);
      const created = info.created_at ?? info.createdAt;
      const expires = info.expires_at ?? info.expiresAt ?? null;
      const mapped: {
        id: string;
        expires_at?: unknown;
        expiresAt?: unknown;
        created_at?: Date | string | number;
        createdAt?: Date | string | number;
      } = { ...info, expires_at: expires };
      if (created !== undefined) {
        mapped.created_at = created;
      }
      return mapped;
    };
  }
  return wrapped;
}

export function wrapOpenSandbox(raw: RawSdk): OpenSandboxModule {
  return {
    SandboxManager: {
      create(config: ConnectionConfig) {
        const created = raw.SandboxManager.create({ connectionConfig: connectionOf(config) });
        return Promise.resolve(created).then((manager) => wrapManager(manager as SandboxManagerHandle));
      },
    },
    Sandbox: {
      async create(image: string, options: Record<string, unknown> = {}) {
        const timeoutSeconds =
          options.timeoutSeconds === undefined ? options.timeout : options.timeoutSeconds;
        const created = await raw.Sandbox.create({
          image,
          timeoutSeconds,
          env: options.env,
          metadata: options.metadata,
          resource: options.resource,
          volumes: normalizeVolumes(options.volumes),
          entrypoint: options.entrypoint,
          connectionConfig: connectionOf(options),
        });
        return wrapHandle(created as SandboxHandle & { kill?: () => Promise<void> });
      },
      async connect(id: string, options: Record<string, unknown> = {}) {
        const connected = await raw.Sandbox.connect({
          sandboxId: id,
          connectionConfig: connectionOf(options),
        });
        return wrapHandle(connected as SandboxHandle & { kill?: () => Promise<void> });
      },
    },
  };
}

async function loadRawOpenSandbox(): Promise<RawSdk> {
  const specifier = process.env.OPENSANDBOX_SDK_MODULE ?? "@alibaba-group/opensandbox";
  try {
    return (await import(specifier)) as RawSdk;
  } catch (error) {
    const src = path.join(
      orchestratorRoot(import.meta.url),
      "node_modules/@alibaba-group/opensandbox/src/index.ts",
    );
    if (existsSync(src)) {
      return (await import(pathToFileURL(src).href)) as RawSdk;
    }
    throw error;
  }
}

export async function openSandboxSdk(): Promise<OpenSandboxModule> {
  return wrapOpenSandbox(await loadRawOpenSandbox());
}

async function loadOpenSandbox(): Promise<OpenSandboxModule> {
  return openSandboxSdk();
}

export class RunSandboxes {
  /** The image every box but lite runs: Chromium and the coding toolchains. */
  image: string;
  /** The image a lite box runs. */
  imageLite: string;
  workspaceRoot: string;
  hostId: string | undefined;
  private config: ConnectionConfig;
  private manager: SandboxManagerHandle | null = null;
  private sdk: OpenSandboxModule | null;
  private sleep: (ms: number) => Promise<void>;
  private readySeconds: number;

  constructor(options: {
    url: string;
    apiKey: string;
    image: string;
    imageLite?: string | undefined;
    workspaceRoot: string;
    hostId?: string | undefined;
    sdk?: OpenSandboxModule | undefined;
    sleep?: ((ms: number) => Promise<void>) | undefined;
    readySeconds?: number | undefined;
  }) {
    this.image = options.image;
    this.imageLite = options.imageLite || options.image;
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

  /** The image the box runs. */
  imageFor(flags: SandboxFlags): string {
    return flags.box === "lite" ? this.imageLite : this.image;
  }

  async ensure(
    agentId: string,
    secrets: Record<string, string>,
    secretIds: string[],
    options: {
      box?: Box;
      browser?: boolean;
      coding?: boolean;
      browserLanguage?: string;
      size?: CustomSize | null | undefined;
      scripts?: RunScriptSnapshot[];
      liveExtra?: Array<{ name: unknown; source: unknown } | Record<string, unknown>>;
    } = {},
  ): Promise<SandboxHandle> {
    const flags = sandboxFlags(options);
    const browser = flags.browser;
    const manager = this.requireManager();
    const sdk = await this.module();
    const matches = await listInfos(manager, {
      states: ["Running"],
      metadata: { agent_id: agentId },
      pageSize: 100,
    });
    const running = splitRunning(matches);
    let keeper = running[0];
    const extras = running[1];
    for (const extra of extras) {
      await killSandbox(manager, extra.id);
    }
    const image = this.imageFor(flags);
    const fingerprint = environmentFingerprint(secrets);
    const metadata = keeper?.metadata;
    if (keeper !== null && !sandboxMatches(metadata, fingerprint, flags, image)) {
      await killSandbox(manager, keeper.id);
      keeper = null;
    }
    let sandbox: SandboxHandle;
    if (keeper !== null) {
      sandbox = await sdk.Sandbox.connect(keeper.id, { connectionConfig: this.config, connection_config: this.config });
      if (browser) {
        await this.waitForBrowser(sandbox);
      }
    } else {
      const workspace = prepareWorkspace(this.workspaceRoot, agentId, flags.box);
      const createOptions: Record<string, unknown> = {
        timeout: null,
        timeoutSeconds: null,
        env: sandboxEnvironment(secrets, flags),
        metadata: sandboxMetadata(agentId, fingerprint, secretIds, {
          ...flags,
          hostId: this.hostId,
          image,
        }),
        resource: sandboxResource(flags),
        volumes: [
          {
            name: "workspace",
            host: { path: workspace },
            mount_path: "/home/agent",
            mountPath: "/home/agent",
            read_only: false,
            readOnly: false,
          },
        ],
        connection_config: this.config,
        connectionConfig: this.config,
      };
      if (browser) {
        createOptions.entrypoint = [...BROWSER_ENTRYPOINT];
      }
      sandbox = await sdk.Sandbox.create(image, createOptions);
      if (browser) {
        await this.waitForBrowser(sandbox);
      }
    }
    await applyRunScripts(sandbox, options.scripts ?? [], options.liveExtra ?? []);
    return sandbox;
  }

  async connectRunning(agentId: string): Promise<SandboxHandle | null> {
    const manager = this.requireManager();
    const sdk = await this.module();
    const matches = await listInfos(manager, {
      states: ["Running"],
      metadata: { agent_id: agentId },
      pageSize: 100,
    });
    const [keeper] = splitRunning(matches);
    if (keeper === null) {
      return null;
    }
    return sdk.Sandbox.connect(keeper.id, { connectionConfig: this.config, connection_config: this.config });
  }

  async novncTarget(sandbox: SandboxHandle): Promise<[string, Record<string, string>]> {
    if (!sandbox.getEndpoint) {
      throw new SandboxError("sandbox cannot resolve endpoints");
    }
    const endpoint = await sandbox.getEndpoint(BROWSER_NOVNC_PORT);
    return [endpointUrl(endpoint), requestHeaders(endpoint, this.config)];
  }

  /**
   * Starts the terminal daemon in the sandbox when it is not already answering
   * and returns the secret path segment it serves under. The helper is
   * idempotent, so a second call on a live daemon returns the same secret.
   */
  async startCli(sandbox: SandboxHandle): Promise<string> {
    let result: CommandResult;
    try {
      result = await sandbox.commands.run(CLI_ENTRYPOINT, { timeoutSeconds: CLI_START_SECONDS });
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
   * The terminal's upstream base, the port's endpoint plus the daemon's secret
   * path, and the host's headers. The sandbox host's proxy drops
   * `Authorization`, so the secret travels in the path instead.
   */
  async cliTarget(sandbox: SandboxHandle, token: string): Promise<[string, Record<string, string>]> {
    if (!sandbox.getEndpoint) {
      throw new SandboxError("sandbox cannot resolve endpoints");
    }
    const endpoint = await sandbox.getEndpoint(CLI_PORT);
    return [`${endpointUrl(endpoint)}/t/${token}`, requestHeaders(endpoint, this.config)];
  }

  async waitForBrowser(sandbox: SandboxHandle): Promise<void> {
    const command =
      "curl -sf -o /dev/null http://127.0.0.1:6080/vnc.html "
      + "&& curl -sf -o /dev/null http://127.0.0.1:9222/json/version";
    for (let attempt = 0; attempt < this.readySeconds; attempt += 1) {
      let result: CommandResult | null;
      try {
        result = await sandbox.commands.run(command, { timeoutSeconds: 5 });
      } catch {
        result = null;
      }
      if (result !== null && exitCode(result) === 0) {
        await this.resetHostHomePage(sandbox);
        return;
      }
      await this.sleep(1000);
    }
    const detail = await this.browserFailureDetail(sandbox);
    let message = "browser session failed to start";
    if (detail) {
      message = `${message}\n${detail}`;
    }
    throw new SandboxError(message);
  }

  private async resetHostHomePage(sandbox: SandboxHandle): Promise<void> {
    const pages = await this.runText(sandbox, "curl -sf http://127.0.0.1:9222/json/list || true");
    if (!browserNeedsBlankReset(pages)) {
      return;
    }
    try {
      await sandbox.commands.run(BLANK_NAVIGATE, { timeoutSeconds: 20 });
    } catch {
      /* error page is still visible in noVNC; do not fail pane open */
    }
  }

  private async browserFailureDetail(sandbox: SandboxHandle): Promise<string> {
    const vnc = await this.runText(
      sandbox,
      "curl -sf -o /dev/null -w '%{http_code}' http://127.0.0.1:6080/vnc.html || echo down",
    );
    const cdp = await this.runText(
      sandbox,
      "curl -sf -o /dev/null -w '%{http_code}' http://127.0.0.1:9222/json/version || echo down",
    );
    const log = await this.runText(sandbox, `tail -n 80 ${BROWSER_START_LOG} || true`);
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

  async agentIdsUsingSecret(secretId: string): Promise<Set<string>> {
    const manager = this.requireManager();
    const matches = await listInfos(manager, { states: ["Running"], pageSize: 100 });
    const agentIds = new Set<string>();
    for (const info of matches) {
      const metadata = info.metadata;
      if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
        continue;
      }
      const agentId = (metadata as { agent_id?: unknown }).agent_id;
      if (metadataSecretIds(metadata).has(secretId) && typeof agentId === "string") {
        agentIds.add(agentId);
      }
    }
    return agentIds;
  }

  async listRunningAgentIds(): Promise<Set<string>> {
    const agentIds = new Set<string>();
    for (const item of await this.listRunning()) {
      agentIds.add(item.agentId);
    }
    return agentIds;
  }

  async listRunning(): Promise<Array<{ agentId: string; browser: boolean; coding: boolean }>> {
    const manager = this.requireManager();
    const matches = await listInfos(manager, { states: ["Running"], pageSize: 100 });
    const running: Array<{ agentId: string; browser: boolean; coding: boolean }> = [];
    for (const info of matches) {
      const metadata = info.metadata;
      if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
        continue;
      }
      const body = metadata as { agent_id?: unknown; browser?: unknown; coding?: unknown };
      if (typeof body.agent_id !== "string") {
        continue;
      }
      running.push({ agentId: body.agent_id, browser: body.browser === "1", coding: body.coding === "1" });
    }
    return running;
  }

  async destroy(agentId: string): Promise<void> {
    const manager = this.requireManager();
    const matches = await listInfos(manager, { metadata: { agent_id: agentId }, pageSize: 100 });
    for (const info of matches) {
      await killSandbox(manager, info.id);
    }
  }
}
