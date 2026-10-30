import { Buffer } from "node:buffer";
import { Type } from "@sinclair/typebox";
import type { MessageMetadata, ReportedToolMetadata } from "../db/schema/index.js";
import { keepMatching } from "../lib/decode.js";
import { stderrOf, stdoutOf, type CommandResult } from "../sandbox/sdk.js";
import { executeCommand } from "./shell.js";
import { functionSchema } from "./schema.js";
import { identityOutput } from "./output.js";
import type { Tool, ToolHooks, ToolRun } from "./types.js";
import { SandboxCommandError, ToolLimitError } from "./errors.js";

/**
 * The tools a coding agent checks its harness's work with. Every call runs `guilds-code`
 * inside the sandbox; the orchestrator never opens a workspace file for them, so a link in
 * the workspace resolves inside the container.
 */
export const CODING_TOOLS = ["shell", "shell_status", "file_read", "code_search"] as const;

export const CODE_HELPER = "/usr/local/bin/guilds-code";
export const HARNESS_HELPER = "/usr/local/bin/guilds-harness";
export const CODE_REQUEST_DIR = "/run/guilds/requests";
/** Longest base64 request passed on the command line; a larger one goes through the file API. */
export const INLINE_REQUEST_MAX = 64 * 1024;
export const CODE_HELPER_TIMEOUT_SECONDS = 120;
export const SHELL_DEFAULT_TIMEOUT_SECONDS = 120;
export const SHELL_MAX_TIMEOUT_SECONDS = 600;
/** Time the helper gets past a shell command's own timeout to stop it and shape the output. */
const SHELL_TIMEOUT_MARGIN_SECONDS = 30;

export function codeResultMaxBytes(env: NodeJS.ProcessEnv = process.env): number {
  const value = Number(env.CODE_RESULT_MAX_BYTES ?? "8192");
  return Number.isInteger(value) && value >= 1024 ? value : 8192;
}

export type CodeResult = { text: string; meta: Record<string, unknown> };

/** A call id as a file name: providers may use characters a path segment cannot hold. */
export function callSegment(callId: string): string {
  const cleaned = callId.replace(/[^A-Za-z0-9_.-]/g, "_").slice(0, 96);
  return cleaned && cleaned !== "." && cleaned !== ".." ? cleaned : `call_${Date.now()}`;
}

export function decodeEnvelope(stdout: string): { ok: boolean; text?: string; meta?: unknown; error?: string } {
  const compact = stdout.replace(/\s+/g, "");
  const decoded = JSON.parse(Buffer.from(compact, "base64").toString("utf8")) as unknown;
  if (!decoded || typeof decoded !== "object" || Array.isArray(decoded)) {
    throw new SandboxCommandError("code helper returned a non-object");
  }
  return decoded as { ok: boolean; text?: string; meta?: unknown; error?: string };
}

/** The command that runs `helper` on `request`: inline, or through a request file when it is too large. */
async function helperCommand(run: ToolRun, helper: string, request: Record<string, unknown>): Promise<string> {
  const json = JSON.stringify(request);
  const encoded = Buffer.from(json, "utf8").toString("base64");
  if (encoded.length <= INLINE_REQUEST_MAX) {
    return `python3 ${helper} ${encoded}`;
  }
  const files = run.sandbox?.files;
  if (!files) {
    throw new ToolLimitError("request is too large for this sandbox");
  }
  const requestPath = `${CODE_REQUEST_DIR}/${run.run_id}-${String(request.call_id)}.json`;
  await files.writeFiles([{ path: requestPath, data: json }]);
  return `python3 ${helper} @${requestPath}`;
}

/** The helper's result from its envelope; throws with its error text, or with stderr when it printed no envelope. */
function helperResult(execution: CommandResult): CodeResult {
  let envelope: ReturnType<typeof decodeEnvelope>;
  try {
    envelope = decodeEnvelope(stdoutOf(execution));
  } catch {
    const detail = stderrOf(execution).split("\n").slice(-5).join("\n");
    throw new SandboxCommandError(`code helper failed${detail ? `: ${detail}` : ""}`);
  }
  if (!envelope.ok) {
    throw new SandboxCommandError(envelope.error || "code helper failed");
  }
  const meta = envelope.meta && typeof envelope.meta === "object" && !Array.isArray(envelope.meta) ? envelope.meta : {};
  return { text: typeof envelope.text === "string" ? envelope.text : "", meta: meta as Record<string, unknown> };
}

const ReportedFields = Type.Object({
  exit_code: Type.Optional(Type.Union([Type.Number(), Type.Null()])),
  cwd: Type.Optional(Type.String()),
  path: Type.Optional(Type.String()),
  range: Type.Optional(Type.Union([Type.Tuple([Type.Number(), Type.Number()]), Type.Null()])),
  content_hash: Type.Optional(Type.String()),
  lines: Type.Optional(Type.Number()),
  log_path: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  timed_out: Type.Optional(Type.Boolean()),
  background_id: Type.Optional(Type.String()),
  state: Type.Optional(Type.String()),
  matches: Type.Optional(Type.Number()),
  files: Type.Optional(Type.Number()),
});

/** The fields of a helper's metadata a call's result keeps; one of another shape is dropped. */
function reportedFields(meta: Record<string, unknown>): ReportedToolMetadata | null {
  return keepMatching(ReportedFields, meta);
}

/** A request a sandbox helper reads: its op, the call it runs for when there is one, and the op's own fields. */
export type HelperRequest = { op: string; call_id?: string; [field: string]: unknown };

/** How a helper request runs: which helper, how long it may take, and how many bytes its text keeps. */
export type HelperSettings = { timeoutSeconds?: number; maxBytes?: number; helper?: string };

/**
 * Runs one op of a sandbox helper (`guilds-code` unless `helper` names another). The request
 * travels base64 on the command line, or through the sandbox file API when it is too large
 * for one argument. Throws with the helper's error text.
 */
export async function runCodeHelper(
  run: ToolRun,
  hooks: ToolHooks,
  request: HelperRequest,
  options: HelperSettings = {},
): Promise<CodeResult> {
  const sent = {
    ...request,
    run_id: run.run_id,
    agent_id: run.agent_id,
    call_id: callSegment(request.call_id || `${request.op}_${Date.now()}`),
    default_cwd: run.code_default_cwd,
    max_bytes: options.maxBytes ?? codeResultMaxBytes(),
  };
  const command = await helperCommand(run, options.helper ?? CODE_HELPER, sent);
  const execution = await executeCommand(run, hooks, command, {
    timeoutSeconds: options.timeoutSeconds ?? CODE_HELPER_TIMEOUT_SECONDS,
  });
  return helperResult(execution);
}

function tool(
  name: string,
  description: string,
  properties: Record<string, unknown>,
  required: string[],
  handler: Tool["handler"],
): Tool {
  return {
    name,
    description,
    output_filter: identityOutput,
    filter_name: "identity",
    schema: functionSchema(name, description, properties, required),
    handler,
  };
}

function shellTimeout(args: Record<string, unknown>): number {
  const raw = args.timeout_seconds;
  const value = typeof raw === "number" && Number.isFinite(raw) ? Math.trunc(raw) : SHELL_DEFAULT_TIMEOUT_SECONDS;
  return Math.max(1, Math.min(SHELL_MAX_TIMEOUT_SECONDS, value));
}

export const shell = tool(
  "shell",
  "Run a bash command in your sandbox and return its combined stdout and stderr. " +
    "The working directory carries over between calls (a cd persists); environment " +
    "changes do not. Output over 8 KiB keeps its first 2 KiB and last 6 KiB and names a " +
    "log file holding all of it. A non-zero exit ends the result with exit_code: N. " +
    "timeout_seconds defaults to 120, at most 600. Set background for a long-running " +
    "process (a dev server, a watcher) and follow it with shell_status. Read files with " +
    "file_read rather than cat. Code changes are your harness's work: use code_task.",
  {
    command: { type: "string" },
    timeout_seconds: { type: "integer", minimum: 1, maximum: SHELL_MAX_TIMEOUT_SECONDS },
    background: { type: "boolean" },
  },
  ["command"],
  async (_services, run, hooks, call) => {
    const args = call.arguments;
    const timeout = shellTimeout(args);
    await hooks.before_command?.();
    const result = await runCodeHelper(
      run,
      hooks,
      { op: "shell", call_id: call.id, command: args.command, timeout_seconds: timeout, background: args.background === true },
      { timeoutSeconds: timeout + SHELL_TIMEOUT_MARGIN_SECONDS },
    );
    call.metadata = reportedFields(result.meta);
    const code = result.meta.exit_code;
    call.exit_code = typeof code === "number" ? code : null;
    return result.text;
  },
);

export const shellStatus = tool(
  "shell_status",
  "Without id, list your background commands with their state. With id, show that " +
    "command's state, exit code, and the last lines of its log; set stop to end it. " +
    "Background commands also end when the sandbox stops after 5 idle minutes.",
  { id: { type: "string" }, stop: { type: "boolean" } },
  [],
  async (_services, run, hooks, call) => {
    const args = call.arguments;
    const result = await runCodeHelper(run, hooks, {
      op: "shell_status",
      call_id: call.id,
      id: typeof args.id === "string" ? args.id : "",
      stop: args.stop === true,
    });
    call.metadata = reportedFields(result.meta);
    return result.text;
  },
);

export const fileRead = tool(
  "file_read",
  "Read a text file as numbered lines under a `path · lines a–b of n` header. offset " +
    "is the first line (default 1); limit is how many lines (default 200, at most 500). " +
    "Lines over 400 characters are clipped. A range you already read, unchanged since, " +
    "returns a pointer to that earlier result instead of the text. Relative paths start " +
    "at the working directory; paths must stay under your home.",
  {
    path: { type: "string" },
    offset: { type: "integer", minimum: 1 },
    limit: { type: "integer", minimum: 1, maximum: 500 },
  },
  ["path"],
  async (_services, run, hooks, call) => {
    const args = call.arguments;
    const result = await runCodeHelper(run, hooks, {
      op: "file_read",
      call_id: call.id,
      path: args.path,
      offset: args.offset,
      limit: args.limit,
    });
    call.metadata = reportedFields(result.meta);
    return result.text;
  },
);

function optional(args: Record<string, unknown>, names: string[]): Record<string, unknown> {
  const picked: Record<string, unknown> = {};
  for (const name of names) {
    if (args[name] !== undefined && args[name] !== null && args[name] !== "") {
      picked[name] = args[name];
    }
  }
  return picked;
}

export const codeSearch = tool(
  "code_search",
  "Search file text with ripgrep, respecting .gitignore. mode files (default) lists the " +
    "matching paths with their match counts, highest first, at most 30, then the totals: " +
    "search paths first. mode content returns path:line: text for at most 40 lines, at " +
    "most 10 matches per file, with context lines (0 to 5) around each. pattern is a " +
    "regex unless fixed; path (default the working directory) and glob (such as *.ts) " +
    "narrow it.",
  {
    pattern: { type: "string" },
    mode: { type: "string", enum: ["files", "content"] },
    path: { type: "string" },
    glob: { type: "string" },
    fixed: { type: "boolean" },
    ignore_case: { type: "boolean" },
    context: { type: "integer", minimum: 0, maximum: 5 },
    limit: { type: "integer", minimum: 1 },
  },
  ["pattern"],
  async (_services, run, hooks, call) => {
    const args = call.arguments;
    const request = {
      op: "code_search",
      call_id: call.id,
      pattern: args.pattern,
      ...optional(args, ["mode", "path", "glob", "context", "limit"]),
      fixed: args.fixed === true,
      ignore_case: args.ignore_case === true,
    };
    const result = await runCodeHelper(run, hooks, request);
    call.metadata = reportedFields(result.meta);
    return result.text;
  },
);

/** The size of the agent's home in MiB, measured with `du` inside the sandbox. */
export async function measureWorkspace(run: ToolRun, hooks: ToolHooks): Promise<number> {
  return measured(await runCodeHelper(run, hooks, { op: "workspace_size" }));
}

/** The size of the agent's machine's directory in MiB: every home on it. */
export async function measureMachine(run: ToolRun, hooks: ToolHooks): Promise<number> {
  return measured(await runCodeHelper(run, hooks, { op: "machine_size" }));
}

function measured(result: CodeResult): number {
  const mib = Number(result.meta.mib);
  if (!Number.isFinite(mib)) {
    throw new SandboxCommandError("workspace size is unavailable");
  }
  return mib;
}

/** A tool result of the run's history, by its seq. */
export type ReadRow = { seq: number; metadata: MessageMetadata };

/** Whether `prior` is a `file_read` result whose text still holds what `metadata`'s read returned. */
function holdsRead(prior: MessageMetadata, metadata: MessageMetadata, range: [number, number]): boolean {
  return (
    prior.tool_name === "file_read" &&
    !prior.error &&
    prior.truncated !== true &&
    prior.repeat_of === undefined &&
    prior.path === metadata.path &&
    prior.content_hash === metadata.content_hash &&
    prior.range !== undefined &&
    prior.range !== null &&
    prior.range[0] <= range[0] &&
    prior.range[1] >= range[1]
  );
}

/**
 * The step of an earlier `file_read` in this run that already holds the lines of this
 * read: same file, same content hash, a range that covers this one, and its text still
 * in history (not itself a pointer).
 */
export function repeatedReadStep(rows: ReadRow[], metadata: MessageMetadata): number | null {
  const range = metadata.range;
  if (metadata.tool_name !== "file_read" || metadata.error || !range || metadata.content_hash === undefined) {
    return null;
  }
  let found: number | null = null;
  for (const row of rows) {
    if (holdsRead(row.metadata, metadata, range)) {
      found = row.seq;
    }
  }
  return found;
}

export function repeatedReadText(metadata: MessageMetadata, step: number): string {
  const range = metadata.range;
  const lines = range ? ` lines ${range[0]}–${range[1]}` : "";
  return `${metadata.path ?? ""}${lines}: unchanged since step ${step}; read that result.`;
}
