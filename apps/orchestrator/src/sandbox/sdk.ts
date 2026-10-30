// The OpenSandbox SDK as the orchestrator calls it: the shapes it speaks in, the readers that take
// each of their spellings, camelCase and snake_case alike, its loading, and the wrappers that map
// its JS signatures onto one surface.
import { existsSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { isPlainRecord } from "../db/json.js";
import { orchestratorRoot } from "../lib/paths.js";

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

export type SandboxInfo = {
  id: string;
  created_at?: Date | string | number;
  createdAt?: Date | string | number;
  metadata?: unknown;
};

export type SandboxEndpoint = {
  endpoint: string;
  headers?: Record<string, string>;
  build_request_headers?: (config: ConnectionConfig) => Record<string, string>;
  buildRequestHeaders?: (config: ConnectionConfig) => Record<string, string>;
};

/** A command's result as the SDK returns it, whose exit code comes under either spelling. */
export type CommandResult = {
  id?: string;
  exit_code?: number | null;
  exitCode?: number | null;
  logs?: { stdout?: Array<{ text?: string }>; stderr?: Array<{ text?: string }> };
};

export type SandboxCommands = {
  run(
    command: string,
    opts?: {
      timeoutSeconds?: number;
      timeout?: number;
      workingDirectory?: string;
      background?: boolean;
      envs?: Record<string, string>;
    },
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

/** A sandbox as the SDK hands it over, which may name its teardown `kill`. */
type RawSandboxHandle = SandboxHandle & { kill?: () => Promise<void> };

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

export type SandboxManagerHandle = {
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

export type OpenSandboxModule = {
  SandboxManager: {
    create(config: ConnectionConfig): SandboxManagerHandle | Promise<SandboxManagerHandle>;
  };
  Sandbox: {
    create(image: string, options: Record<string, unknown>): Promise<SandboxHandle>;
    connect(id: string, options: Record<string, unknown>): Promise<SandboxHandle>;
  };
};

/** What the SDK's manager is created with: the connection, under whichever spelling the caller gave it. */
export type RawManagerOptions = { connectionConfig: unknown };

/** What the SDK creates a sandbox from: its image, lifetime, labels, size, mounts, and connection. */
export type RawCreateOptions = {
  image: string;
  timeoutSeconds: unknown;
  env: unknown;
  metadata: unknown;
  resource: unknown;
  volumes: unknown;
  entrypoint: unknown;
  connectionConfig: unknown;
};

/** What the SDK connects to a running sandbox with: its id and the connection. */
export type RawConnectOptions = { sandboxId: string; connectionConfig: unknown };

/**
 * The OpenSandbox SDK as its module exports it. What each call takes is known; what each returns
 * is checked to be a manager or a sandbox before it is wrapped.
 */
export type RawSdk = {
  SandboxManager: { create(options: RawManagerOptions): unknown };
  Sandbox: {
    create(options: RawCreateOptions): Promise<unknown>;
    connect(options: RawConnectOptions): Promise<unknown>;
  };
};

/** What a manager is asked to list: the sandboxes in these states that carry these labels. */
export type SandboxFilter = {
  states?: string[];
  metadata?: Record<string, string>;
  pageSize: number;
};

/** How a command runs: its time limit, its directory, whether it detaches, and what it adds to the environment. */
export type CommandOptions = {
  timeoutSeconds?: number;
  workingDirectory?: string;
  background?: boolean;
  envs?: Record<string, string>;
};

function isStringRecord(value: unknown): value is Record<string, string> {
  return isPlainRecord(value) && Object.values(value).every((item) => typeof item === "string");
}

/** Whether `value` is an object, a class included, whose `name` member is a function. */
function hasFunction(value: unknown, name: string): boolean {
  if (value === null || (typeof value !== "object" && typeof value !== "function")) {
    return false;
  }
  return typeof Reflect.get(value, name) === "function";
}

/** Whether each member named is a function or absent. */
function optionalFunctions(value: Record<string, unknown>, names: readonly string[]): boolean {
  return names.every((name) => value[name] === undefined || typeof value[name] === "function");
}

const MANAGER_METHODS = [
  "listSandboxInfos",
  "list_sandbox_infos",
  "killSandbox",
  "kill_sandbox",
  "getSandboxInfo",
  "close",
] as const;
const HANDLE_METHODS = ["getEndpoint", "close", "destroy", "kill"] as const;

/** Whether a module exports the SDK's calls: `SandboxManager.create`, `Sandbox.create`, `Sandbox.connect`. */
function isRawSdk(value: unknown): value is RawSdk {
  return (
    isPlainRecord(value)
    && hasFunction(value.SandboxManager, "create")
    && hasFunction(value.Sandbox, "create")
    && hasFunction(value.Sandbox, "connect")
  );
}

/** Whether the SDK's manager is an object whose methods, under each spelling it has, are functions. */
function isSandboxManagerHandle(value: unknown): value is SandboxManagerHandle {
  return isPlainRecord(value) && optionalFunctions(value, MANAGER_METHODS);
}

/** Whether the SDK's sandbox has an id and a command runner, and its other members are of their types. */
function isRawSandboxHandle(value: unknown): value is RawSandboxHandle {
  return (
    isPlainRecord(value)
    && typeof value.id === "string"
    && hasFunction(value.commands, "run")
    && (value.files === undefined || isPlainRecord(value.files))
    && optionalFunctions(value, HANDLE_METHODS)
  );
}

function sandboxOf(value: unknown): RawSandboxHandle {
  if (!isRawSandboxHandle(value)) {
    throw new SandboxError("the sandbox SDK returned a sandbox without an id and a command runner");
  }
  return value;
}

/** A command's options from either spelling of each: `timeout`, `working_directory`, and `env` included. */
export function commandOptions(opts: unknown): CommandOptions {
  if (!isPlainRecord(opts)) {
    return {};
  }
  const options: CommandOptions = {};
  const timeout = opts.timeoutSeconds ?? opts.timeout;
  if (typeof timeout === "number") {
    options.timeoutSeconds = timeout;
  }
  const workingDirectory = opts.workingDirectory ?? opts.working_directory;
  if (typeof workingDirectory === "string") {
    options.workingDirectory = workingDirectory;
  }
  if (typeof opts.background === "boolean") {
    options.background = opts.background;
  }
  const envs = opts.envs ?? opts.env;
  if (isStringRecord(envs)) {
    options.envs = envs;
  }
  return options;
}

/** The exit code a command's result reports, under either spelling; undefined when it reports none. */
export function exitCodeOf(result: CommandResult | null | undefined): number | undefined {
  return result?.exit_code ?? result?.exitCode ?? undefined;
}

/** What a command printed, its lines joined and trimmed. */
export function stdoutOf(result: CommandResult | null | undefined): string {
  const messages = result?.logs?.stdout ?? [];
  return messages.map((item) => item.text ?? "").join("\n").trim();
}

/** What a command printed on stderr, its lines joined and trimmed. */
export function stderrOf(result: CommandResult | null | undefined): string {
  const messages = result?.logs?.stderr ?? [];
  return messages.map((item) => item.text ?? "").join("\n").trim();
}

/** When a listed sandbox was created, in milliseconds since the epoch; 0 when it does not say. */
export function createdAtOf(info: SandboxInfo): number {
  const raw = info.created_at ?? info.createdAt;
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

/** The headers a request to the endpoint carries, from whichever builder it has, else its own. */
export function endpointHeaders(endpoint: SandboxEndpoint, config: ConnectionConfig): Record<string, string> {
  const build = endpoint.build_request_headers ?? endpoint.buildRequestHeaders;
  if (typeof build === "function") {
    return build(config);
  }
  return { ...(endpoint.headers ?? {}) };
}

function listerOf(manager: SandboxManagerHandle): (filter: Record<string, unknown>) => Promise<ListMatches> {
  const list = manager.listSandboxInfos ?? manager.list_sandbox_infos;
  if (!list) {
    throw new SandboxError("sandbox manager cannot list sandboxes");
  }
  return (filter) => list.call(manager, filter);
}

/** The sandboxes the manager lists for the filter, under whichever spelling its answer uses. */
export async function listSandboxes(manager: SandboxManagerHandle, filter: SandboxFilter): Promise<SandboxInfo[]> {
  const matches: ListMatches | null | undefined = await listerOf(manager)(filter);
  const infos = matches?.sandbox_infos ?? matches?.sandboxInfos ?? matches?.items ?? [];
  return Array.isArray(infos) ? infos : [];
}

/** Kills one sandbox through the manager, under whichever spelling its method uses. */
export async function killSandbox(manager: SandboxManagerHandle, id: string): Promise<void> {
  const kill = manager.killSandbox ?? manager.kill_sandbox;
  if (!kill) {
    throw new SandboxError("sandbox manager cannot kill sandboxes");
  }
  await kill.call(manager, id);
}

function connectionOf(value: unknown): unknown {
  if (!isPlainRecord(value)) {
    return value;
  }
  return value.connectionConfig ?? value.connection_config ?? value;
}

function normalizeVolumes(value: unknown): unknown {
  if (!Array.isArray(value)) {
    return value;
  }
  return value.map((item) => {
    if (!isPlainRecord(item)) {
      return item;
    }
    return {
      ...item,
      mountPath: item.mountPath ?? item.mount_path,
      readOnly: item.readOnly ?? item.read_only ?? false,
    };
  });
}

function initHandlerOf(value: unknown): unknown {
  return isPlainRecord(value) ? (value.onInit ?? value.on_init) : undefined;
}

function commandHandlers(opts: unknown, handlers: unknown): unknown {
  const onInit = initHandlerOf(handlers) ?? initHandlerOf(opts);
  if (!onInit) {
    return handlers || undefined;
  }
  return { ...(isPlainRecord(handlers) ? handlers : {}), onInit };
}

function wrapCommands(commands: SandboxCommands): SandboxCommands {
  const wrapped: SandboxCommands = {
    run: async (command, opts, handlers) => {
      const run = commands.run.bind(commands);
      return run(command, commandOptions(opts), commandHandlers(opts, handlers));
    },
  };
  if (commands.createSession) {
    wrapped.createSession = async (workingDirectory) => {
      const create = commands.createSession!.bind(commands);
      if (typeof workingDirectory === "string") {
        return create({ workingDirectory });
      }
      const directory = workingDirectory?.workingDirectory ?? workingDirectory?.working_directory;
      return create(directory ? { workingDirectory: directory } : workingDirectory);
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

function wrapHandle(sandbox: RawSandboxHandle): SandboxHandle {
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
  const getInfo = manager.getSandboxInfo;
  const list = async (filter: Record<string, unknown>): Promise<ListMatches> =>
    listerOf(manager)({ ...filter, pageSize: filter.pageSize ?? filter.page_size ?? 100 });
  const kill = async (id: string): Promise<void> => killSandbox(manager, id);
  const wrapped: SandboxManagerHandle = {
    listSandboxInfos: list,
    killSandbox: kill,
    list_sandbox_infos: list,
    kill_sandbox: kill,
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
        return Promise.resolve(created).then((manager: unknown) => {
          if (!isSandboxManagerHandle(manager)) {
            throw new SandboxError("the sandbox SDK returned a manager that is not an object of methods");
          }
          return wrapManager(manager);
        });
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
        return wrapHandle(sandboxOf(created));
      },
      async connect(id: string, options: Record<string, unknown> = {}) {
        const connected = await raw.Sandbox.connect({
          sandboxId: id,
          connectionConfig: connectionOf(options),
        });
        return wrapHandle(sandboxOf(connected));
      },
    },
  };
}

/** The SDK module: `OPENSANDBOX_SDK_MODULE` or the package, else the package's source when it is not built. */
async function importOpenSandbox(): Promise<unknown> {
  const specifier = process.env.OPENSANDBOX_SDK_MODULE ?? "@alibaba-group/opensandbox";
  try {
    return await import(specifier);
  } catch (error) {
    const src = path.join(
      orchestratorRoot(import.meta.url),
      "node_modules/@alibaba-group/opensandbox/src/index.ts",
    );
    if (existsSync(src)) {
      return await import(pathToFileURL(src).href);
    }
    throw error;
  }
}

/** The SDK, wrapped; a module that does not export the calls made of it throws `SandboxError`. */
export async function openSandboxSdk(): Promise<OpenSandboxModule> {
  const loaded = await importOpenSandbox();
  if (!isRawSdk(loaded)) {
    throw new SandboxError("the sandbox SDK module does not export SandboxManager.create, Sandbox.create and Sandbox.connect");
  }
  return wrapOpenSandbox(loaded);
}
