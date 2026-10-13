import { Buffer } from "node:buffer";
import { credentialFix, HARNESS_INFO, HARNESS_MISSING_MESSAGE, type Harness } from "../coding/harnesses.js";
import { writeLog } from "../observability/log.js";
import { readArtifactText } from "./artifacts.js";
import { callSegment, codeResultMaxBytes, HARNESS_HELPER, runCodeHelper, type CodeResult } from "./code.js";
import { functionSchema } from "./schema.js";
import { identityOutput } from "./output.js";
import type { CancelEvent, Tool, ToolContext } from "./types.js";

export const HARNESS_TOOLS = ["code_task"] as const;
export const CODE_TASK_DEFAULT_MINUTES = 30;
export const CODE_TASK_MAX_MINUTES = 60;
/** How often a running call is polled, and how long its minutes are; tests shorten both. */
export const harnessTiming = { pollMs: 3000, minuteMs: 60_000 };
/** The content of `notes` appended to a brief, at most. */
export const BRIEF_NOTES_MAX_BYTES = 64 * 1024;
const HARNESS_OP_TIMEOUT_SECONDS = 60;
const CHECKPOINT_TIMEOUT_SECONDS = 300;
/** Consecutive failed polls after which the call ends `interrupted`. */
const POLL_FAILURES_MAX = 3;
const FILES_SHOWN = 30;
const PROGRESS_LINE_CHARS = 240;

export type CodeTaskStatus = "completed" | "failed" | "timed_out" | "cancelled" | "interrupted";

/** What every brief starts with: the harness works alone and never publishes. */
export const BRIEF_PREAMBLE = [
  "You are working on a task delegated to you by an agent. You cannot reach its operator, and",
  "nobody answers questions while you work. When you are blocked or need a decision, stop and",
  "ask in your final message, saying exactly what you need. You may commit on the current",
  "branch. Never push and never open pull requests. End with what you changed and what you ran.",
].join("\n");

/** The tool-call context the harness ops run under: not interrupted mid-exec; the poll loop stops the harness itself. */
function opsContext(ctx: ToolContext): ToolContext {
  return { ...ctx, cancel_event: null, track_command: null };
}

async function harnessOp(
  ctx: ToolContext,
  op: string,
  args: Record<string, unknown>,
  timeoutSeconds = HARNESS_OP_TIMEOUT_SECONDS,
): Promise<CodeResult> {
  return runCodeHelper(ctx, op, args, { helper: HARNESS_HELPER, timeoutSeconds });
}

function repositoryFor(ctx: ToolContext, args: Record<string, unknown>): string {
  const names = ctx.code_repositories;
  const named = typeof args.repo === "string" ? args.repo.trim() : "";
  if (!names.length) {
    throw new Error("this guild has no repositories; the operator adds them in the guild's Repositories");
  }
  if (named) {
    if (!names.includes(named)) {
      throw new Error(`unknown repository ${named}; the guild's repositories are ${names.join(", ")}`);
    }
    return named;
  }
  if (names.length === 1) {
    return names[0]!;
  }
  throw new Error(`repo is required: the guild's repositories are ${names.join(", ")}`);
}

function timeoutMinutes(args: Record<string, unknown>): number {
  const raw = args.timeout_minutes;
  const value = typeof raw === "number" && Number.isFinite(raw) ? Math.trunc(raw) : CODE_TASK_DEFAULT_MINUTES;
  return Math.max(1, Math.min(CODE_TASK_MAX_MINUTES, value));
}

function notePaths(args: Record<string, unknown>): string[] {
  const raw = args.notes;
  if (raw === undefined || raw === null) {
    return [];
  }
  if (!Array.isArray(raw) || raw.some((item) => typeof item !== "string")) {
    throw new Error("notes must be a list of display paths");
  }
  return [...new Set((raw as string[]).map((item) => item.trim()).filter(Boolean))];
}

/** The fixed preamble, the brief, and each note under its display path while they fit the cap. */
export async function buildBrief(ctx: ToolContext, brief: string, paths: string[]): Promise<string> {
  const parts = [BRIEF_PREAMBLE, `# Task\n\n${brief.trim()}`];
  let used = 0;
  const left: string[] = [];
  for (const path of paths) {
    let loaded: { path: string; text: string };
    try {
      loaded = await readArtifactText(ctx, path);
    } catch (error) {
      throw new Error(`notes: ${path}: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
    }
    const section = `# ${loaded.path}\n\n${loaded.text.trim()}`;
    const size = Buffer.byteLength(section, "utf8");
    if (used + size > BRIEF_NOTES_MAX_BYTES) {
      left.push(loaded.path);
      continue;
    }
    used += size;
    parts.push(section);
  }
  if (left.length) {
    parts.push(`Not included, past the ${BRIEF_NOTES_MAX_BYTES / 1024} KiB cap for notes: ${left.join(", ")}`);
  }
  return parts.join("\n\n") + "\n";
}

/** Waits `ms`, or until the run is cancelled. */
async function pause(ms: number, cancel: CancelEvent | null): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  const elapsed = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, ms);
  });
  if (cancel === null) {
    await elapsed;
    return;
  }
  const abort = new AbortController();
  try {
    await Promise.race([elapsed, cancel.wait(abort.signal).catch(() => undefined)]);
  } finally {
    clearTimeout(timer);
    abort.abort();
  }
}

/** A progress line as the run view shows it, cut after redaction so no secret is cut in two. */
export function clipProgressLine(line: string): string {
  return line.length <= PROGRESS_LINE_CHARS ? line : `${line.slice(0, PROGRESS_LINE_CHARS - 1)}…`;
}

export function formatDuration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  if (hours) {
    return `${hours}h${String(minutes % 60).padStart(2, "0")}m`;
  }
  return minutes ? `${minutes}m${String(seconds % 60).padStart(2, "0")}s` : `${seconds}s`;
}

type ChangedFile = { path: string; insertions: number | null; deletions: number | null };

export type CodeTaskOutcome = {
  status: CodeTaskStatus;
  harness: Harness;
  repository: string;
  session_id: string | null;
  duration_ms: number;
  files_changed: number;
  insertions: number;
  deletions: number;
  files: ChangedFile[];
  detail: string;
  message: string;
  log_path: string;
};

/** Keeps the end of `text` within `budget` bytes: questions and summaries come last. */
function keepEnd(text: string, budget: number): string {
  const data = Buffer.from(text, "utf8");
  if (data.length <= budget) {
    return text;
  }
  const marker = `[… ${data.length - budget} bytes cut from the start of the message]\n`;
  const room = Math.max(0, budget - Buffer.byteLength(marker, "utf8"));
  return marker + data.subarray(data.length - room).toString("utf8").replace(/^�+/, "");
}

/** The result the agent reads, within `maxBytes`; the final message gives way first, from its start. */
export function codeTaskText(outcome: CodeTaskOutcome, maxBytes = codeResultMaxBytes()): string {
  const head = [
    `${outcome.status} · ${outcome.harness} · ${outcome.repository} · session ${outcome.session_id ?? "none"} · ${formatDuration(outcome.duration_ms)}`,
    outcome.files_changed
      ? `${outcome.files_changed} file${outcome.files_changed === 1 ? "" : "s"} changed, +${outcome.insertions} −${outcome.deletions}`
      : "no files changed",
  ];
  for (const file of outcome.files.slice(0, FILES_SHOWN)) {
    const counts = file.insertions === null ? "binary" : `+${file.insertions} −${file.deletions ?? 0}`;
    head.push(`${file.path} (${counts})`);
  }
  if (outcome.files_changed > Math.min(outcome.files.length, FILES_SHOWN)) {
    head.push(`… ${outcome.files_changed - Math.min(outcome.files.length, FILES_SHOWN)} more files`);
  }
  if (outcome.detail) {
    head.push(outcome.detail);
  }
  const tail = `log: ${outcome.log_path}`;
  const fixed = `${head.join("\n")}\n\n\n\n${tail}`;
  const budget = maxBytes - Buffer.byteLength(fixed, "utf8") - 16;
  const message = keepEnd(outcome.message.trim() || "(no final message)", Math.max(0, budget));
  return `${head.join("\n")}\n\n${message}\n\n${tail}`;
}

/** The result of a call the orchestrator never saw finish: it restarted while the harness ran. */
export function interruptedText(task: {
  harness: Harness;
  repository: string;
  session_id: string | null;
  log_path: string | null;
  run_id: string;
  call_id: string;
}): string {
  return [
    `interrupted · ${task.harness} · ${task.repository} · session ${task.session_id ?? "none"}`,
    "The harness was stopped before it finished: the orchestrator or the machine restarted. The",
    "working tree holds whatever it wrote, and the task's start checkpoint stays at",
    `refs/guild/runs/${task.run_id}/tasks/${task.call_id}/start.` +
      (task.session_id ? " Resume the session to finish the work." : ""),
    "",
    `log: ${task.log_path ?? "none"}`,
  ].join("\n");
}

function displayLogPath(runId: string, callId: string): string {
  return `.runs/${runId}/${callId}.harness.jsonl`;
}

function failureDetail(harness: Harness, result: Record<string, unknown>, version: string | null): string {
  const events = Number(result.events ?? 0);
  if (events === 0 && Number(result.unparsed ?? 0) > 0) {
    return `error: the ${harness} driver does not parse this CLI's output (${version ?? "unknown version"})`;
  }
  const stderr = typeof result.stderr === "string" ? result.stderr.trim().split("\n").slice(-5).join("\n") : "";
  // A CLI that printed no event, such as one refusing to start without a login, says why on stderr.
  if (events === 0 && stderr) {
    return `error: ${stderr}`;
  }
  if (typeof result.error === "string" && result.error) {
    return `error: ${result.error.split("\n")[0]}`;
  }
  if (stderr) {
    return `error: ${stderr}`;
  }
  return `error: exited with code ${String(result.exit_code ?? "unknown")}`;
}

async function checkpoint(
  ctx: ToolContext,
  which: "start" | "end",
  callId: string,
  repository: string,
): Promise<Record<string, unknown> | null> {
  try {
    const result = await runCodeHelper(
      ctx,
      "checkpoint",
      { which, task: callId, repositories: [repository] },
      { timeoutSeconds: CHECKPOINT_TIMEOUT_SECONDS },
    );
    const records = Array.isArray(result.meta.repositories) ? result.meta.repositories : [];
    return (records[0] as Record<string, unknown> | undefined) ?? null;
  } catch (error) {
    writeLog("warn", error instanceof Error ? error.message : String(error), {
      run_id: ctx.run_id,
      agent_id: ctx.agent_id,
      operation: "code_task.checkpoint",
    });
    return null;
  }
}

export const codeTask: Tool = {
  name: "code_task",
  description:
    "Delegate code work to your coding harness, which runs in your sandbox against one of the " +
    "guild's repositories and returns its final message, its session id, and the files it " +
    "changed. The harness sees nothing of this conversation, your notes, or Memory: brief is " +
    "the whole task, self-contained. notes lists display paths of notes or records whose " +
    "content is appended to the brief. Pass session_id to resume an earlier session (to answer " +
    "its question or follow up) in the repository it started in. repo is a name under repos/, " +
    "optional when the guild has one. timeout_minutes defaults to 30, at most 60. The harness " +
    "may commit but never pushes; check its work, then push and open pull requests yourself.",
  output_filter: identityOutput,
  filter_name: "identity",
  schema: functionSchema(
    "code_task",
    "Delegate code work to your coding harness and return its result.",
    {
      brief: { type: "string", description: "The whole task, self-contained." },
      repo: { type: "string", description: "Repository name under repos/." },
      session_id: { type: "string", description: "Resume this harness session." },
      notes: {
        type: "array",
        items: { type: "string" },
        description: "Display paths of notes or records to append to the brief.",
      },
      timeout_minutes: { type: "integer", minimum: 1, maximum: CODE_TASK_MAX_MINUTES },
    },
    ["brief"],
  ),
  async handler(ctx, args) {
    const harness = ctx.harness;
    if (harness === null) {
      throw new Error(HARNESS_MISSING_MESSAGE);
    }
    const info = HARNESS_INFO[harness];
    const brief = typeof args.brief === "string" ? args.brief : "";
    if (!brief.trim()) {
      throw new Error("brief is required");
    }
    const repository = repositoryFor(ctx, args);
    const sessionId = typeof args.session_id === "string" && args.session_id.trim() ? args.session_id.trim() : null;
    const minutes = timeoutMinutes(args);
    const ops = opsContext(ctx);
    const callId = callSegment(ctx.tool_call_id || `code_task_${Date.now()}`);
    ops.tool_call_id = callId;

    const check = await harnessOp(ops, "check", { harness });
    if (check.meta.installed !== true) {
      const fix =
        harness === "codex"
          ? "rebuild the runtime image, which always installs it"
          : `build the runtime image with HARNESSES naming ${harness}`;
      throw new Error(`${info.label} is not installed in this machine's image: ${fix}`);
    }
    const version = typeof check.meta.version === "string" ? check.meta.version : null;
    if (check.meta.credential === "login") {
      await ctx.harness_login_seen?.(harness);
    } else if (check.meta.credential !== "secret") {
      throw new Error(`${info.label} has no credential: ${credentialFix(harness, { cli: ctx.cli })}`);
    }
    const prompt = await buildBrief(ctx, brief, notePaths(args));

    const start = await checkpoint(ops, "start", callId, repository);
    await ctx.before_command?.();
    const started = Date.now();
    const deadline = started + minutes * harnessTiming.minuteMs;
    await harnessOp(ops, "start", {
      harness,
      repository,
      prompt,
      ...(sessionId ? { session_id: sessionId } : {}),
    });
    const logPath = displayLogPath(ctx.run_id, callId);
    let session = sessionId;
    const remember = async () =>
      ctx.remember_harness_task?.({ call_id: callId, harness, repository, session_id: session, log_path: logPath });
    await remember();

    let status: CodeTaskStatus | null = null;
    let offset = 0;
    let failures = 0;
    let stopped = false;
    for (;;) {
      if (ctx.cancel_event?.aborted) {
        status = "cancelled";
      } else if (Date.now() >= deadline) {
        status = "timed_out";
      }
      if (status !== null) {
        await harnessOp(ops, "stop", { harness }).catch(() => undefined);
        stopped = true;
        break;
      }
      let poll: CodeResult;
      try {
        await ctx.before_command?.();
        poll = await harnessOp(ops, "poll", { harness, offset });
        failures = 0;
      } catch (error) {
        failures += 1;
        if (failures >= POLL_FAILURES_MAX) {
          writeLog("warn", error instanceof Error ? error.message : String(error), {
            run_id: ctx.run_id,
            agent_id: ctx.agent_id,
            operation: "code_task.poll",
          });
          status = "interrupted";
          break;
        }
        await pause(harnessTiming.pollMs, ctx.cancel_event);
        continue;
      }
      if (poll.meta.missing === true) {
        status = "interrupted";
        break;
      }
      offset = typeof poll.meta.offset === "number" ? poll.meta.offset : offset;
      const lines = Array.isArray(poll.meta.lines) ? poll.meta.lines.map(String) : [];
      const seen = typeof poll.meta.session_id === "string" ? poll.meta.session_id : null;
      if (seen && seen !== session) {
        session = seen;
        await remember();
      }
      if (lines.length) {
        await ctx.publish_progress?.(ctx.tool_call_id, { lines, session_id: session });
      }
      if (poll.meta.exited === true) {
        break;
      }
      await pause(Math.min(harnessTiming.pollMs, Math.max(0, deadline - Date.now())), ctx.cancel_event);
    }

    let message = "";
    let detail = "";
    let exitCode: number | null = null;
    if (status !== "interrupted") {
      const result = await harnessOp(ops, "result", { harness }).catch(() => null);
      if (result === null || result.meta.missing === true) {
        status = status ?? "interrupted";
      } else {
        session = typeof result.meta.session_id === "string" ? result.meta.session_id : session;
        exitCode = typeof result.meta.exit_code === "number" ? result.meta.exit_code : null;
        message = typeof result.meta.message === "string" ? result.meta.message : "";
        if (status === null) {
          status = exitCode === 0 && result.meta.is_error !== true ? "completed" : "failed";
        }
        if (status === "failed") {
          detail = failureDetail(harness, result.meta, version);
        }
      }
    }
    if (status === "interrupted") {
      detail = "The harness stopped reporting: the machine restarted or its container was recreated.";
    } else if (stopped) {
      detail =
        status === "timed_out"
          ? `Stopped after ${minutes} minutes. Resume the session to continue.`
          : "Stopped: the generation was cancelled.";
    }
    const end = await checkpoint(ops, "end", callId, repository);
    const changed = (end ?? {}) as Record<string, unknown>;
    const outcome: CodeTaskOutcome = {
      status: status ?? "failed",
      harness,
      repository,
      session_id: session,
      duration_ms: Date.now() - started,
      files_changed: Number(changed.files_changed ?? 0) || 0,
      insertions: Number(changed.insertions ?? 0) || 0,
      deletions: Number(changed.deletions ?? 0) || 0,
      files: Array.isArray(changed.files) ? (changed.files as ChangedFile[]) : [],
      detail,
      message,
      log_path: logPath,
    };
    ctx.exit_code = exitCode;
    ctx.tool_metadata = {
      harness,
      status: outcome.status,
      session_id: session,
      repository,
      exit_code: exitCode,
      duration_ms: outcome.duration_ms,
      files_changed: outcome.files_changed,
      insertions: outcome.insertions,
      deletions: outcome.deletions,
      start_sha: (start?.start_sha as string | undefined) ?? (changed.start_sha as string | undefined) ?? null,
      end_sha: (changed.end_sha as string | undefined) ?? null,
      log_path: logPath,
    };
    return codeTaskText(outcome);
  },
};
