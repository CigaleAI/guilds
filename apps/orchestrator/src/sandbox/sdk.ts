// The OpenSandbox SDK as the orchestrator calls it: the shapes it speaks in, its loading, and the
// wrappers that map its JS signatures, camelCase and snake_case alike, onto one surface.
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

export type CommandResult = {
  id?: string;
  exit_code?: number;
  exitCode?: number;
  logs?: { stdout?: Array<{ text?: string }> };
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

export type ListMatches = {
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

export type RawSdk = {
  SandboxManager: { create: (opts?: unknown) => unknown };
  Sandbox: {
    create: (opts: unknown) => Promise<unknown>;
    connect: (opts: unknown) => Promise<unknown>;
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

/** The exit code a command's result reports, under either spelling. */
export function exitCodeOf(result: CommandResult | null | undefined): number | undefined {
  return result?.exit_code ?? result?.exitCode;
}

/** What a command printed, its lines joined and trimmed. */
export function stdoutOf(result: CommandResult | null | undefined): string {
  const messages = result?.logs?.stdout ?? [];
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
