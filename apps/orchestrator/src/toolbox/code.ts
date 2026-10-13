import { Buffer } from "node:buffer";
import { executeCommand } from "./shell.js";
import { functionSchema } from "./schema.js";
import { identityOutput } from "./output.js";
import type { Tool, ToolContext } from "./types.js";

/**
 * The code tools of a coding agent. Every call runs `guilds-code` inside the sandbox;
 * the orchestrator never opens a workspace file for them, so a link in the workspace
 * resolves inside the container.
 */
export const SHELL_TOOLS = ["shell", "shell_status"] as const;
export const FILE_TOOLS = ["file_read", "file_edit", "file_write"] as const;
export const SEARCH_TOOLS = [
  "code_search",
  "code_match",
  "code_map",
  "code_find",
  "code_outline",
  "code_callers",
] as const;
export const CODING_TOOLS = [...SHELL_TOOLS, ...FILE_TOOLS, ...SEARCH_TOOLS] as const;

export const CODE_HELPER = "/usr/local/bin/guilds-code";
export const CODE_REQUEST_DIR = "/run/guilds/requests";
/** Longest base64 request passed on the command line; a larger one goes through the file API. */
export const INLINE_REQUEST_MAX = 64 * 1024;
export const CODE_HELPER_TIMEOUT_SECONDS = 120;
/** Graph calls may build a repository's graph first. */
export const CODE_GRAPH_TIMEOUT_SECONDS = 660;
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
    throw new Error("code helper returned a non-object");
  }
  return decoded as { ok: boolean; text?: string; meta?: unknown; error?: string };
}

function stdoutOf(execution: { logs?: { stdout?: Array<{ text?: string }> } }): string {
  return (execution.logs?.stdout ?? []).map((message) => message.text ?? "").join("");
}

function stderrOf(execution: { logs?: { stderr?: Array<{ text?: string }> } }): string {
  return (execution.logs?.stderr ?? []).map((message) => message.text ?? "").join("\n").trim();
}

/**
 * Runs one helper op. The request travels base64 on the command line, or through the
 * sandbox file API when it is too large for one argument. Throws with the helper's
 * error text; otherwise records the helper's metadata on the call.
 */
export async function runCodeHelper(
  ctx: ToolContext,
  op: string,
  args: Record<string, unknown>,
  options: { timeoutSeconds?: number; maxBytes?: number } = {},
): Promise<CodeResult> {
  const callId = callSegment(ctx.tool_call_id || `${op}_${Date.now()}`);
  const request = {
    ...args,
    op,
    run_id: ctx.run_id,
    agent_id: ctx.agent_id,
    call_id: callId,
    default_cwd: ctx.code_default_cwd,
    max_bytes: options.maxBytes ?? codeResultMaxBytes(),
  };
  const json = JSON.stringify(request);
  const encoded = Buffer.from(json, "utf8").toString("base64");
  let command: string;
  if (encoded.length <= INLINE_REQUEST_MAX) {
    command = `python3 ${CODE_HELPER} ${encoded}`;
  } else {
    const files = ctx.sandbox?.files;
    if (!files) {
      throw new Error("request is too large for this sandbox");
    }
    const requestPath = `${CODE_REQUEST_DIR}/${ctx.run_id}-${callId}.json`;
    await files.writeFiles([{ path: requestPath, data: json }]);
    command = `python3 ${CODE_HELPER} @${requestPath}`;
  }
  const execution = await executeCommand(ctx, command, {
    timeoutSeconds: options.timeoutSeconds ?? CODE_HELPER_TIMEOUT_SECONDS,
  });
  let envelope: ReturnType<typeof decodeEnvelope>;
  try {
    envelope = decodeEnvelope(stdoutOf(execution));
  } catch {
    const detail = stderrOf(execution).split("\n").slice(-5).join("\n");
    throw new Error(`code helper failed${detail ? `: ${detail}` : ""}`);
  }
  if (!envelope.ok) {
    throw new Error(envelope.error || "code helper failed");
  }
  const meta =
    envelope.meta && typeof envelope.meta === "object" && !Array.isArray(envelope.meta)
      ? (envelope.meta as Record<string, unknown>)
      : {};
  ctx.tool_metadata = meta;
  return { text: typeof envelope.text === "string" ? envelope.text : "", meta };
}

function tool(
  name: string,
  description: string,
  properties: Record<string, unknown>,
  required: string[],
  handler: (ctx: ToolContext, args: Record<string, unknown>) => Promise<string>,
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
    "process (a dev server, a watcher) and follow it with shell_status. Use file_read, " +
    "file_edit, and file_write rather than cat, sed, or heredocs for files.",
  {
    command: { type: "string" },
    timeout_seconds: { type: "integer", minimum: 1, maximum: SHELL_MAX_TIMEOUT_SECONDS },
    background: { type: "boolean" },
  },
  ["command"],
  async (ctx, args) => {
    const timeout = shellTimeout(args);
    await ctx.before_command?.();
    const result = await runCodeHelper(
      ctx,
      "shell",
      { command: args.command, timeout_seconds: timeout, background: args.background === true },
      { timeoutSeconds: timeout + SHELL_TIMEOUT_MARGIN_SECONDS },
    );
    const code = result.meta.exit_code;
    ctx.exit_code = typeof code === "number" ? code : null;
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
  async (ctx, args) => {
    const result = await runCodeHelper(ctx, "shell_status", {
      id: typeof args.id === "string" ? args.id : "",
      stop: args.stop === true,
    });
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
  async (ctx, args) => {
    const result = await runCodeHelper(ctx, "file_read", {
      path: args.path,
      offset: args.offset,
      limit: args.limit,
    });
    return result.text;
  },
);

export const fileEdit = tool(
  "file_edit",
  "Replace an exact string in a file. old_string must match the file exactly, " +
    "whitespace included, and occur once, or set replace_all to change every " +
    "occurrence; otherwise nothing changes and the result says why. Include enough " +
    "surrounding lines to make old_string unique. Returns edited <path> (+added −removed).",
  {
    path: { type: "string" },
    old_string: { type: "string" },
    new_string: { type: "string" },
    replace_all: { type: "boolean" },
  },
  ["path", "old_string", "new_string"],
  async (ctx, args) => {
    const result = await runCodeHelper(ctx, "file_edit", {
      path: args.path,
      old_string: args.old_string,
      new_string: args.new_string,
      replace_all: args.replace_all === true,
    });
    return result.text;
  },
);

export const fileWrite = tool(
  "file_write",
  "Create a file, or replace one whole, with content; missing folders are created. " +
    "Use file_edit to change part of an existing file. Returns wrote <path> (n lines).",
  { path: { type: "string" }, content: { type: "string" } },
  ["path", "content"],
  async (ctx, args) => {
    const result = await runCodeHelper(ctx, "file_write", {
      path: args.path,
      content: args.content,
    });
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
    "most 10 matches per file, with context lines (0 to 5) around each. mode symbols " +
    "groups hits under their enclosing function or class with its span and how many " +
    "places reference it (the code graph's languages only). pattern is a regex unless " +
    "fixed; path (default the working directory) and glob (such as *.ts) narrow it.",
  {
    pattern: { type: "string" },
    mode: { type: "string", enum: ["files", "content", "symbols"] },
    path: { type: "string" },
    glob: { type: "string" },
    fixed: { type: "boolean" },
    ignore_case: { type: "boolean" },
    context: { type: "integer", minimum: 0, maximum: 5 },
    limit: { type: "integer", minimum: 1 },
  },
  ["pattern"],
  async (ctx, args) => {
    const request = {
      pattern: args.pattern,
      ...optional(args, ["mode", "path", "glob", "context", "limit"]),
      fixed: args.fixed === true,
      ignore_case: args.ignore_case === true,
    };
    const graph = args.mode === "symbols";
    const result = await runCodeHelper(ctx, "code_search", request, {
      timeoutSeconds: graph ? CODE_GRAPH_TIMEOUT_SECONDS : CODE_HELPER_TIMEOUT_SECONDS,
    });
    return result.text;
  },
);

export const codeMatch = tool(
  "code_match",
  "Find code by its syntax with ast-grep: a pattern in the target language where $NAME " +
    "matches one node and $$$ARGS any number, such as `fetch($URL, $$$)` or `class $C " +
    "extends Base { $$$ }`. Unlike text search it skips comments and strings. lang " +
    "(typescript, tsx, javascript, python, go, rust, java, …) is inferred from file " +
    "extensions when omitted. Returns path:line with the first matched line.",
  {
    pattern: { type: "string" },
    lang: { type: "string" },
    path: { type: "string" },
    limit: { type: "integer", minimum: 1, maximum: 100 },
  },
  ["pattern"],
  async (ctx, args) => {
    const result = await runCodeHelper(ctx, "code_match", {
      pattern: args.pattern,
      ...optional(args, ["lang", "path", "limit"]),
    });
    return result.text;
  },
);

export const codeMap = tool(
  "code_map",
  "Orient in a repository under repos/ in your home before reading it: its directory " +
    "clusters with file and symbol counts, each cluster's most referenced symbols, and " +
    "the most referenced symbols overall, with path:line. repo is the folder name under " +
    "repos/ in your home; by default the repository holding the working directory.",
  { repo: { type: "string" } },
  [],
  async (ctx, args) => {
    const result = await runCodeHelper(ctx, "code_map", optional(args, ["repo"]), {
      timeoutSeconds: CODE_GRAPH_TIMEOUT_SECONDS,
    });
    return result.text;
  },
);

export const codeFind = tool(
  "code_find",
  "Ask where something is handled, in plain words (\"where are refunds validated\"), and " +
    "get the ranked symbols and files that answer it with path:line and their " +
    "signatures; with source, a short excerpt of each instead. in narrows to a folder " +
    "or file of the repository; limit defaults to 8. Read the ranges it points to " +
    "instead of whole files.",
  {
    question: { type: "string" },
    in: { type: "string" },
    source: { type: "boolean" },
    limit: { type: "integer", minimum: 1, maximum: 20 },
  },
  ["question"],
  async (ctx, args) => {
    const result = await runCodeHelper(
      ctx,
      "code_find",
      { question: args.question, source: args.source === true, ...optional(args, ["in", "limit"]) },
      { timeoutSeconds: CODE_GRAPH_TIMEOUT_SECONDS },
    );
    return result.text;
  },
);

export const codeOutline = tool(
  "code_outline",
  "Every signature in one source file with its line span, without bodies: read this " +
    "before the file, then read only the ranges you need.",
  { path: { type: "string" } },
  ["path"],
  async (ctx, args) => {
    const result = await runCodeHelper(ctx, "code_outline", { path: args.path }, {
      timeoutSeconds: CODE_GRAPH_TIMEOUT_SECONDS,
    });
    return result.text;
  },
);

export const codeCallers = tool(
  "code_callers",
  "What references a symbol (direction in, the default: callers, importers, " +
    "subclasses) or what it references (direction out), with path:line. symbol is a " +
    "bare name, Class.method, or pkg.Fn. depth 1 to 3 follows the chain further for " +
    "the blast radius of a change. in narrows matches to a folder or file.",
  {
    symbol: { type: "string" },
    direction: { type: "string", enum: ["in", "out"] },
    depth: { type: "integer", minimum: 1, maximum: 3 },
    in: { type: "string" },
  },
  ["symbol"],
  async (ctx, args) => {
    const result = await runCodeHelper(
      ctx,
      "code_callers",
      { symbol: args.symbol, ...optional(args, ["direction", "depth", "in"]) },
      { timeoutSeconds: CODE_GRAPH_TIMEOUT_SECONDS },
    );
    return result.text;
  },
);

/** The workspace size in MiB, measured with `du` inside the sandbox. */
/** The size of the agent's home in MiB. */
export async function measureWorkspace(ctx: ToolContext): Promise<number> {
  return measured(await runCodeHelper(ctx, "workspace_size", {}));
}

/** The size of the agent's machine's directory in MiB: every home on it. */
export async function measureMachine(ctx: ToolContext): Promise<number> {
  return measured(await runCodeHelper(ctx, "machine_size", {}));
}

function measured(result: CodeResult): number {
  const mib = Number(result.meta.mib);
  if (!Number.isFinite(mib)) {
    throw new Error("workspace size is unavailable");
  }
  return mib;
}

type ReadRow = { seq: number; metadata: Record<string, unknown> };

function readRange(metadata: Record<string, unknown>): [number, number] | null {
  const range = metadata.range;
  if (!Array.isArray(range) || range.length !== 2) {
    return null;
  }
  const [start, end] = range;
  return typeof start === "number" && typeof end === "number" ? [start, end] : null;
}

/**
 * The step of an earlier `file_read` in this run that already holds the lines of this
 * read: same file, same content hash, a range that covers this one, and its text still
 * in history (not itself a pointer).
 */
export function repeatedReadStep(rows: ReadRow[], metadata: Record<string, unknown>): number | null {
  if (metadata.tool_name !== "file_read" || metadata.error) {
    return null;
  }
  const range = readRange(metadata);
  if (range === null || typeof metadata.content_hash !== "string") {
    return null;
  }
  let found: number | null = null;
  for (const row of rows) {
    const prior = row.metadata;
    if (
      prior.tool_name !== "file_read" ||
      prior.error ||
      prior.truncated === true ||
      prior.repeat_of !== undefined ||
      prior.path !== metadata.path ||
      prior.content_hash !== metadata.content_hash
    ) {
      continue;
    }
    const held = readRange(prior);
    if (held !== null && held[0] <= range[0] && held[1] >= range[1]) {
      found = row.seq;
    }
  }
  return found;
}

export function repeatedReadText(metadata: Record<string, unknown>, step: number): string {
  const range = readRange(metadata);
  const lines = range ? ` lines ${range[0]}–${range[1]}` : "";
  return `${String(metadata.path)}${lines}: unchanged since step ${step}; read that result.`;
}

const EDIT_TOOLS = new Set(["file_edit", "file_write"]);

/**
 * How much a coding run explored before acting: the tool calls before its first file edit
 * (null until it edits one), and the bytes `file_read` returned from files it never edited.
 */
export function explorationOf(rows: Array<{ metadata: Record<string, unknown> }>): {
  calls_before_first_edit: number | null;
  read_bytes_unedited: number;
} {
  const tools = rows.map((row) => row.metadata).filter((meta) => typeof meta.tool_name === "string");
  const firstEdit = tools.findIndex((meta) => EDIT_TOOLS.has(String(meta.tool_name)) && !meta.error);
  const edited = new Set(
    tools
      .filter((meta) => EDIT_TOOLS.has(String(meta.tool_name)) && !meta.error && typeof meta.path === "string")
      .map((meta) => String(meta.path)),
  );
  let unedited = 0;
  for (const meta of tools) {
    if (meta.tool_name === "file_read" && !meta.error && typeof meta.path === "string" && !edited.has(meta.path)) {
      unedited += Number(meta.stored_bytes ?? 0) || 0;
    }
  }
  return { calls_before_first_edit: firstEdit === -1 ? null : firstEdit, read_bytes_unedited: unedited };
}
