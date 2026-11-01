// The OpenSandbox SDK as the orchestrator calls it: the shapes it speaks in, the readers that take
// each of their spellings, camelCase and snake_case alike, its loading, and the wrappers that map
// its JS signatures onto one surface.
//
// The SDK's module is loaded at run time, from a path the environment may substitute, and the
// package installed from source carries no built types. This module is therefore where the
// application decides what it got: `isSandboxSdk` when the module loads, and
// `isSandboxManagerHandle` and `isRawSandboxHandle` when the SDK hands over a manager or a sandbox.
// Past those three, every value is of the type this module names for it.
import { existsSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
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

/** A moment as the SDK reports it: a date, its text, or milliseconds since the epoch. */
export type SandboxTime = Date | string | number;

/** The labels a container carries, by name. */
export type SandboxLabels = Record<string, string>;

/** A sandbox as its manager lists or describes it: its id, its creation and expiry, and its labels. */
export type SandboxInfo = {
  id: string;
  created_at?: SandboxTime;
  createdAt?: SandboxTime;
  expires_at?: SandboxTime | null;
  expiresAt?: SandboxTime | null;
  metadata?: SandboxLabels;
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

/** What a command reports once it starts: its execution id, which interrupts it. */
export type CommandInit = { id?: string };

/** What hears a command start. */
export type CommandInitHandler = (init: CommandInit) => Promise<void> | void;

/** The hooks a command calls as it runs: the one that hears it start, under either spelling. */
export type CommandHandlers = {
  onInit?: CommandInitHandler;
  on_init?: CommandInitHandler;
};

/** How a command runs: its time limit, its directory, whether it detaches, and what it adds to the environment. */
export type CommandOptions = {
  timeoutSeconds?: number;
  workingDirectory?: string;
  background?: boolean;
  envs?: Record<string, string>;
};

/** How a caller asks for a command: each option under either spelling, the start hook among them. */
export type CommandRunOptions = CommandOptions
  & CommandHandlers
  & {
    timeout?: number;
    working_directory?: string;
    env?: Record<string, string>;
  };

export type SandboxCommands = {
  run(command: string, opts?: CommandRunOptions, handlers?: CommandHandlers): Promise<CommandResult>;
  createSession?(workingDirectory?: string): Promise<string>;
  runInSession?(sessionId: string, command: string): Promise<CommandResult>;
  deleteSession?(sessionId: string): Promise<void>;
  interrupt?(executionId: string): Promise<void>;
  getCommandStatus?(executionId: string): Promise<{ running?: boolean }>;
};

/** Where the SDK opens a session: the directory its commands start in. */
type SessionOptions = { workingDirectory?: string };

/** A sandbox's commands as the SDK hands them over, whose session takes its directory as an option. */
type RawSandboxCommands = Omit<SandboxCommands, "createSession"> & {
  createSession?(options?: SessionOptions): Promise<string>;
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
type RawSandboxHandle = Omit<SandboxHandle, "commands"> & {
  commands: RawSandboxCommands;
  kill?: () => Promise<void>;
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

/** What a manager is asked to list: the sandboxes in these states that carry these labels, a page at a time. */
export type SandboxFilter = {
  states?: string[];
  metadata?: SandboxLabels;
  pageSize?: number;
  page_size?: number;
};

export type SandboxManagerHandle = {
  listSandboxInfos?(filter: SandboxFilter): Promise<ListMatches>;
  list_sandbox_infos?(filter: SandboxFilter): Promise<ListMatches>;
  killSandbox?(id: string): Promise<void>;
  kill_sandbox?(id: string): Promise<void>;
  getSandboxInfo?(id: string): Promise<SandboxInfo>;
  close?(): Promise<void>;
};

/** What a sandbox is created with, as OpenSandbox takes it: CPUs and memory with a `Mi` suffix. */
export type SandboxResource = { cpu: string; memory: string };

/** A host directory a sandbox mounts: where it is on the host, where it is mounted, and whether read-only. */
export type SandboxVolume = {
  name: string;
  host: { path: string };
  mountPath?: string;
  mount_path?: string;
  readOnly?: boolean;
  read_only?: boolean;
};

/** The connection a sandbox is reached through, under either spelling. */
export type SandboxConnectOptions = {
  connectionConfig?: ConnectionConfig;
  connection_config?: ConnectionConfig;
};

/** What a sandbox is created with: its lifetime, environment, labels, size, mounts, entrypoint, and connection. */
export type SandboxCreateOptions = SandboxConnectOptions & {
  timeoutSeconds?: number | null;
  timeout?: number | null;
  env?: Record<string, string>;
  metadata?: SandboxLabels;
  resource?: SandboxResource;
  volumes?: SandboxVolume[];
  entrypoint?: string[];
};

export type OpenSandboxModule = {
  SandboxManager: {
    create(config: ConnectionConfig): SandboxManagerHandle | Promise<SandboxManagerHandle>;
  };
  Sandbox: {
    create(image: string, options: SandboxCreateOptions): Promise<SandboxHandle>;
    connect(id: string, options: SandboxConnectOptions): Promise<SandboxHandle>;
  };
};

/** What the SDK's manager is created with: the connection. */
export type RawManagerOptions = { connectionConfig: ConnectionConfig };

/** A mount as the SDK takes it: the host directory, where it is mounted, and whether read-only. */
export type RawVolume = { name: string; host: { path: string }; mountPath: string; readOnly: boolean };

/** What the SDK creates a sandbox from: its image, lifetime, labels, size, mounts, and connection. */
export type RawCreateOptions = {
  image: string;
  timeoutSeconds: number | null | undefined;
  env: Record<string, string> | undefined;
  metadata: SandboxLabels | undefined;
  resource: SandboxResource | undefined;
  volumes: RawVolume[] | undefined;
  entrypoint: string[] | undefined;
  connectionConfig: ConnectionConfig | undefined;
};

/** What the SDK connects to a running sandbox with: its id and the connection. */
export type RawConnectOptions = { sandboxId: string; connectionConfig: ConnectionConfig | undefined };

/**
 * The OpenSandbox SDK as its module exports it: the manager's class and the sandbox's, each with
 * the calls made of it. What each call takes is known; what each returns is checked to be a
 * manager or a sandbox before it is wrapped.
 */
export type SandboxSdk = {
  SandboxManager: { create(options: RawManagerOptions): unknown };
  Sandbox: {
    create(options: RawCreateOptions): Promise<unknown>;
    connect(options: RawConnectOptions): Promise<unknown>;
  };
};

const MANAGER_METHODS = [
  "listSandboxInfos",
  "list_sandbox_infos",
  "killSandbox",
  "kill_sandbox",
  "getSandboxInfo",
  "close",
] as const;
const HANDLE_METHODS = ["getEndpoint", "close", "destroy", "kill"] as const;

/** Whether the SDK's manager class, or the object standing for it, has `create`. */
function isManagerClass(value: unknown): value is SandboxSdk["SandboxManager"] {
  if (typeof value !== "function" && (typeof value !== "object" || value === null)) {
    return false;
  }
  return typeof Reflect.get(value, "create") === "function";
}

/** Whether the SDK's sandbox class, or the object standing for it, has `create` and `connect`. */
function isSandboxClass(value: unknown): value is SandboxSdk["Sandbox"] {
  if (typeof value !== "function" && (typeof value !== "object" || value === null)) {
    return false;
  }
  return typeof Reflect.get(value, "create") === "function" && typeof Reflect.get(value, "connect") === "function";
}

/** Whether a module exports the SDK's calls: `SandboxManager.create`, `Sandbox.create`, `Sandbox.connect`. */
function isSandboxSdk(value: unknown): value is SandboxSdk {
  return (
    typeof value === "object"
    && value !== null
    && isManagerClass(Reflect.get(value, "SandboxManager"))
    && isSandboxClass(Reflect.get(value, "Sandbox"))
  );
}

/** Whether the SDK's manager is an object whose methods, under each spelling it has, are functions. */
function isSandboxManagerHandle(value: unknown): value is SandboxManagerHandle {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  for (const name of MANAGER_METHODS) {
    const method: unknown = Reflect.get(value, name);
    if (method !== undefined && typeof method !== "function") {
      return false;
    }
  }
  return true;
}

/** Whether a sandbox's commands can run a command. */
function isCommandRunner(value: unknown): value is RawSandboxCommands {
  return typeof value === "object" && value !== null && typeof Reflect.get(value, "run") === "function";
}

/** Whether a sandbox's files are an object, or absent. */
function isFilesApi(value: unknown): value is SandboxFiles | undefined {
  return value === undefined || (typeof value === "object" && value !== null);
}

/** Whether the SDK's sandbox has an id and a command runner, and its other members are of their types. */
function isRawSandboxHandle(value: unknown): value is RawSandboxHandle {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  for (const name of HANDLE_METHODS) {
    const method: unknown = Reflect.get(value, name);
    if (method !== undefined && typeof method !== "function") {
      return false;
    }
  }
  return (
    typeof Reflect.get(value, "id") === "string"
    && isCommandRunner(Reflect.get(value, "commands"))
    && isFilesApi(Reflect.get(value, "files"))
  );
}

function assertSandbox(value: unknown): asserts value is RawSandboxHandle {
  if (!isRawSandboxHandle(value)) {
    throw new SandboxError("the sandbox SDK returned a sandbox without an id and a command runner");
  }
}

/** A command's options from either spelling of each: `timeout`, `working_directory`, and `env` included. */
export function commandOptions(opts: CommandRunOptions | undefined): CommandOptions {
  const options: CommandOptions = {};
  if (opts === undefined) {
    return options;
  }
  const timeout = opts.timeoutSeconds ?? opts.timeout;
  if (timeout !== undefined) {
    options.timeoutSeconds = timeout;
  }
  const workingDirectory = opts.workingDirectory ?? opts.working_directory;
  if (workingDirectory !== undefined) {
    options.workingDirectory = workingDirectory;
  }
  if (opts.background !== undefined) {
    options.background = opts.background;
  }
  const envs = opts.envs ?? opts.env;
  if (envs !== undefined) {
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
  if (raw === undefined) {
    return 0;
  }
  const time = new Date(raw).getTime();
  return Number.isNaN(time) ? 0 : time;
}

/** The headers a request to the endpoint carries, from whichever builder it has, else its own. */
export function endpointHeaders(endpoint: SandboxEndpoint, config: ConnectionConfig): Record<string, string> {
  const build = endpoint.build_request_headers ?? endpoint.buildRequestHeaders;
  return build ? build(config) : (endpoint.headers ?? {});
}

function listerOf(manager: SandboxManagerHandle): (filter: SandboxFilter) => Promise<ListMatches> {
  const list = manager.listSandboxInfos ?? manager.list_sandbox_infos;
  if (!list) {
    throw new SandboxError("sandbox manager cannot list sandboxes");
  }
  return (filter) => list.call(manager, filter);
}

/** The sandboxes the manager lists for the filter, under whichever spelling its answer uses. */
export async function listSandboxes(manager: SandboxManagerHandle, filter: SandboxFilter): Promise<SandboxInfo[]> {
  const matches = await listerOf(manager)(filter);
  return matches.sandbox_infos ?? matches.sandboxInfos ?? matches.items ?? [];
}

/** Kills one sandbox through the manager, under whichever spelling its method uses. */
export async function killSandbox(manager: SandboxManagerHandle, id: string): Promise<void> {
  const kill = manager.killSandbox ?? manager.kill_sandbox;
  if (!kill) {
    throw new SandboxError("sandbox manager cannot kill sandboxes");
  }
  await kill.call(manager, id);
}

function connectionOf(options: SandboxConnectOptions): ConnectionConfig | undefined {
  return options.connectionConfig ?? options.connection_config;
}

/** A mount as the SDK takes it, from either spelling of where it is mounted and whether read-only. */
function rawVolume(volume: SandboxVolume): RawVolume {
  const mountPath = volume.mountPath ?? volume.mount_path;
  if (mountPath === undefined) {
    throw new SandboxError(`sandbox volume ${volume.name} names no mount path`);
  }
  return { name: volume.name, host: volume.host, mountPath, readOnly: volume.readOnly ?? volume.read_only ?? false };
}

/** The hooks the SDK calls as a command runs: the start hook the handlers or the options name. */
function commandHandlers(
  opts: CommandRunOptions | undefined,
  handlers: CommandHandlers | undefined,
): CommandHandlers | undefined {
  const onInit = handlers?.onInit ?? handlers?.on_init ?? opts?.onInit ?? opts?.on_init;
  return onInit === undefined ? undefined : { onInit };
}

function wrapCommands(commands: RawSandboxCommands): SandboxCommands {
  const wrapped: SandboxCommands = {
    run: async (command, opts, handlers) =>
      commands.run(command, commandOptions(opts), commandHandlers(opts, handlers)),
  };
  if (commands.createSession) {
    const create = commands.createSession.bind(commands);
    wrapped.createSession = async (workingDirectory) =>
      create(workingDirectory === undefined ? undefined : { workingDirectory });
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
  const list = async (filter: SandboxFilter): Promise<ListMatches> =>
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
      const mapped: SandboxInfo = { ...info, expires_at: info.expires_at ?? info.expiresAt ?? null };
      if (created !== undefined) {
        mapped.created_at = created;
      }
      return mapped;
    };
  }
  return wrapped;
}

export function wrapOpenSandbox(raw: SandboxSdk): OpenSandboxModule {
  return {
    SandboxManager: {
      async create(config: ConnectionConfig) {
        const manager = await raw.SandboxManager.create({ connectionConfig: config });
        if (!isSandboxManagerHandle(manager)) {
          throw new SandboxError("the sandbox SDK returned a manager that is not an object of methods");
        }
        return wrapManager(manager);
      },
    },
    Sandbox: {
      async create(image: string, options: SandboxCreateOptions) {
        const created = await raw.Sandbox.create({
          image,
          timeoutSeconds: options.timeoutSeconds === undefined ? options.timeout : options.timeoutSeconds,
          env: options.env,
          metadata: options.metadata,
          resource: options.resource,
          volumes: options.volumes?.map(rawVolume),
          entrypoint: options.entrypoint,
          connectionConfig: connectionOf(options),
        });
        assertSandbox(created);
        return wrapHandle(created);
      },
      async connect(id: string, options: SandboxConnectOptions) {
        const connected = await raw.Sandbox.connect({
          sandboxId: id,
          connectionConfig: connectionOf(options),
        });
        assertSandbox(connected);
        return wrapHandle(connected);
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
  if (!isSandboxSdk(loaded)) {
    throw new SandboxError("the sandbox SDK module does not export SandboxManager.create, Sandbox.create and Sandbox.connect");
  }
  return wrapOpenSandbox(loaded);
}
