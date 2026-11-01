import { Buffer } from "node:buffer";
import { Type } from "@sinclair/typebox";
import type { MessageMetadata, ReportedToolMetadata } from "../db/schema/index.js";
import { keepMatching } from "../lib/decode.js";
import { isJsonObject, isObjectNode, type JsonObject } from "../lib/json.js";
import { stderrOf, stdoutOf, type CommandResult } from "../sandbox/sdk.js";
import { executeCommand } from "./shell.js";
import { jsonArgument, wholeWithin } from "./schema.js";
import { nativeTool, type ToolHooks, type ToolRun } from "./types.js";
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

export type CodeResult = { text: string; meta: JsonObject };

/** A call id as a file name: providers may use characters a path segment cannot hold. */
export function callSegment(callId: string): string {
  const cleaned = callId.replace(/[^A-Za-z0-9_.-]/g, "_").slice(0, 96);
  return cleaned && cleaned !== "." && cleaned !== ".." ? cleaned : `call_${Date.now()}`;
}

/** What a sandbox helper prints: whether its op succeeded, its text and meta, and its error text when it says one. */
export type HelperEnvelope = { ok: boolean; text: string; meta: JsonObject; error: string | null };

/** The fields of an envelope the helper printed, each one kept when it holds what the envelope puts there. */
const EnvelopeFields = Type.Object({
  ok: Type.Optional(Type.Boolean()),
  text: Type.Optional(Type.String()),
  error: Type.Optional(Type.String()),
});

/** The envelope a helper printed as base64 JSON; throws when it is not a JSON object. */
export function decodeEnvelope(stdout: string): HelperEnvelope {
  const compact = stdout.replace(/\s+/g, "");
  const decoded: unknown = JSON.parse(Buffer.from(compact, "base64").toString("utf8"));
  if (!isJsonObject(decoded)) {
    throw new SandboxCommandError("code helper returned a non-object");
  }
  const fields = keepMatching(EnvelopeFields, decoded) ?? {};
  const meta = decoded.meta;
  return {
    ok: fields.ok === true,
    text: fields.text ?? "",
    meta: meta !== undefined && isObjectNode(meta) ? meta : {},
    error: fields.error || null,
  };
}

/** A request as a helper is sent it: the op's own fields, and the run and call it runs for. */
type SentRequest = HelperRequest & { run_id: string; agent_id: string; call_id: string; default_cwd: string; max_bytes: number };

/** The command that runs `helper` on `request`: inline, or through a request file when it is too large. */
async function helperCommand(run: ToolRun, helper: string, request: SentRequest): Promise<string> {
  const json = JSON.stringify(request);
  const encoded = Buffer.from(json, "utf8").toString("base64");
  if (encoded.length <= INLINE_REQUEST_MAX) {
    return `python3 ${helper} ${encoded}`;
  }
  const files = run.sandbox?.files;
  if (!files) {
    throw new ToolLimitError("request is too large for this sandbox");
  }
  const requestPath = `${CODE_REQUEST_DIR}/${run.run_id}-${request.call_id}.json`;
  await files.writeFiles([{ path: requestPath, data: json }]);
  return `python3 ${helper} @${requestPath}`;
}

/** The helper's result from its envelope; throws with its error text, or with stderr when it printed no envelope. */
function helperResult(execution: CommandResult): CodeResult {
  let envelope: HelperEnvelope;
  try {
    envelope = decodeEnvelope(stdoutOf(execution));
  } catch {
    const detail = stderrOf(execution).split("\n").slice(-5).join("\n");
    throw new SandboxCommandError(`code helper failed${detail ? `: ${detail}` : ""}`);
  }
  if (!envelope.ok) {
    throw new SandboxCommandError(envelope.error ?? "code helper failed");
  }
  return { text: envelope.text, meta: envelope.meta };
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
function reportedFields(meta: JsonObject): ReportedToolMetadata | null {
  return keepMatching(ReportedFields, meta);
}

/** A request a sandbox helper reads: its op, the call it runs for when there is one, and the op's own fields. */
export type HelperRequest = JsonObject & { op: string; call_id?: string };

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
  const sent: SentRequest = {
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

/** How long a `shell` command may run, in seconds: the default when the call gives none, kept within the range. */
const SHELL_TIMEOUT = { min: 1, max: SHELL_MAX_TIMEOUT_SECONDS, fallback: SHELL_DEFAULT_TIMEOUT_SECONDS };

export const shell = nativeTool({
  name: "shell",
  description:
    "Run a bash command in your sandbox and return its combined stdout and stderr. " +
    "The working directory carries over between calls (a cd persists); environment " +
    "changes do not. Output over 8 KiB keeps its first 2 KiB and last 6 KiB and names a " +
    "log file holding all of it. A non-zero exit ends the result with exit_code: N. " +
    "timeout_seconds defaults to 120, at most 600. Set background for a long-running " +
    "process (a dev server, a watcher) and follow it with shell_status. Read files with " +
    "file_read rather than cat. Code changes are your harness's work: use code_task.",
  parameters: Type.Object({
    command: Type.String(),
    timeout_seconds: Type.Optional(jsonArgument({ type: "integer", minimum: 1, maximum: SHELL_MAX_TIMEOUT_SECONDS })),
    background: Type.Optional(Type.Boolean()),
  }),
  handler: async (_services, run, hooks, call) => {
    const { command, background = false } = call.arguments;
    const timeout = wholeWithin(call.arguments.timeout_seconds, SHELL_TIMEOUT);
    await hooks.before_command?.();
    const result = await runCodeHelper(
      run,
      hooks,
      { op: "shell", call_id: call.id, command, timeout_seconds: timeout, background },
      { timeoutSeconds: timeout + SHELL_TIMEOUT_MARGIN_SECONDS },
    );
    call.metadata = reportedFields(result.meta);
    call.exit_code = call.metadata?.exit_code ?? null;
    return result.text;
  },
});

export const shellStatus = nativeTool({
  name: "shell_status",
  description:
    "Without id, list your background commands with their state. With id, show that " +
    "command's state, exit code, and the last lines of its log; set stop to end it. " +
    "Background commands also end when the sandbox stops after 5 idle minutes.",
  parameters: Type.Object({ id: Type.Optional(Type.String()), stop: Type.Optional(Type.Boolean()) }),
  handler: async (_services, run, hooks, call) => {
    const { id = "", stop = false } = call.arguments;
    const result = await runCodeHelper(run, hooks, { op: "shell_status", call_id: call.id, id, stop });
    call.metadata = reportedFields(result.meta);
    return result.text;
  },
});

export const fileRead = nativeTool({
  name: "file_read",
  description:
    "Read a text file as numbered lines under a `path · lines a–b of n` header. offset " +
    "is the first line (default 1); limit is how many lines (default 200, at most 500). " +
    "Lines over 400 characters are clipped. A range you already read, unchanged since, " +
    "returns a pointer to that earlier result instead of the text. Relative paths start " +
    "at the working directory; paths must stay under your home.",
  parameters: Type.Object({
    path: Type.String(),
    offset: Type.Optional(Type.Integer({ minimum: 1 })),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 500 })),
  }),
  handler: async (_services, run, hooks, call) => {
    const { path, offset, limit } = call.arguments;
    const result = await runCodeHelper(run, hooks, {
      op: "file_read",
      call_id: call.id,
      path,
      ...(offset === undefined ? {} : { offset }),
      ...(limit === undefined ? {} : { limit }),
    });
    call.metadata = reportedFields(result.meta);
    return result.text;
  },
});

export const codeSearch = nativeTool({
  name: "code_search",
  description:
    "Search file text with ripgrep, respecting .gitignore. mode files (default) lists the " +
    "matching paths with their match counts, highest first, at most 30, then the totals: " +
    "search paths first. mode content returns path:line: text for at most 40 lines, at " +
    "most 10 matches per file, with context lines (0 to 5) around each. pattern is a " +
    "regex unless fixed; path (default the working directory) and glob (such as *.ts) " +
    "narrow it.",
  parameters: Type.Object({
    pattern: Type.String(),
    mode: Type.Optional(Type.String({ enum: ["files", "content"] })),
    path: Type.Optional(Type.String()),
    glob: Type.Optional(Type.String()),
    fixed: Type.Optional(Type.Boolean()),
    ignore_case: Type.Optional(Type.Boolean()),
    context: Type.Optional(Type.Integer({ minimum: 0, maximum: 5 })),
    limit: Type.Optional(Type.Integer({ minimum: 1 })),
  }),
  handler: async (_services, run, hooks, call) => {
    const { pattern, mode, path, glob, context, limit, fixed = false, ignore_case = false } = call.arguments;
    const request = {
      op: "code_search",
      call_id: call.id,
      pattern,
      ...(mode ? { mode } : {}),
      ...(path ? { path } : {}),
      ...(glob ? { glob } : {}),
      ...(context === undefined ? {} : { context }),
      ...(limit === undefined ? {} : { limit }),
      fixed,
      ignore_case,
    };
    const result = await runCodeHelper(run, hooks, request);
    call.metadata = reportedFields(result.meta);
    return result.text;
  },
});

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
