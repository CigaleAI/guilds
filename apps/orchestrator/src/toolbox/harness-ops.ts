import { Type, type Static } from "@sinclair/typebox";
import type { Effort, Harness } from "../db/schema/index.js";
import { keepMatching } from "../lib/decode.js";
import { isObjectNode } from "../lib/json.js";
import { errorMessage, writeLog } from "../observability/log.js";
import { redact } from "../secrets/index.js";
import { HARNESS_HELPER, runCodeHelper, type CodeResult } from "./code.js";
import { createToolHooks, type ToolRun } from "./types.js";

const HARNESS_OP_TIMEOUT_SECONDS = 60;
const CHECKPOINT_TIMEOUT_SECONDS = 300;
const PROGRESS_LINE_CHARS = 240;

/** A text field of an op's meta; null when it is absent or empty. */
export function stringOrNull(value: string | undefined): string | null {
  return value || null;
}

// Each op's meta as a turn reads it. A field that does not hold what the helper puts there is
// dropped, so the turn reads it as absent.

/** What a `poll` op says: whether the call's state is gone, the log offset reached, the session and new progress lines it saw, and whether the harness exited. */
export const HarnessPoll = Type.Object({
  missing: Type.Optional(Type.Boolean()),
  offset: Type.Optional(Type.Number()),
  session_id: Type.Optional(Type.String()),
  lines: Type.Optional(Type.Array(Type.String())),
  exited: Type.Optional(Type.Boolean()),
});
export type HarnessPoll = Static<typeof HarnessPoll>;

/**
 * What the `result` op says of a harness that exited: whether the call's state is gone, the
 * CLI's exit code and error flag, its session and final message, how many events it printed and
 * how many lines were not JSON, and the end of its stderr and its error text.
 */
export const HarnessExit = Type.Object({
  missing: Type.Optional(Type.Boolean()),
  exit_code: Type.Optional(Type.Union([Type.Number(), Type.Null()])),
  is_error: Type.Optional(Type.Boolean()),
  session_id: Type.Optional(Type.String()),
  message: Type.Optional(Type.String()),
  events: Type.Optional(Type.Number()),
  unparsed: Type.Optional(Type.Number()),
  stderr: Type.Optional(Type.String()),
  error: Type.Optional(Type.String()),
});
export type HarnessExit = Static<typeof HarnessExit>;

/** What the `stop` op says: whether the harness has exited. */
export const HarnessStop = Type.Object({ exited: Type.Optional(Type.Boolean()) });

/** What the `check` op says: whether the CLI is installed, its version, the credential it would run on, and whose login it is. */
export const HarnessCheckMeta = Type.Object({
  installed: Type.Optional(Type.Boolean()),
  version: Type.Optional(Type.String()),
  credential: Type.Optional(Type.Union([Type.Literal("secret"), Type.Literal("login")])),
  account: Type.Optional(Type.String()),
});
export type HarnessCheckMeta = Static<typeof HarnessCheckMeta>;

/** What the `log` op says of a call's kept log: whether it is gone, its progress lines, what was cut, its size, and its events. */
const HarnessLogMeta = Type.Object({
  missing: Type.Optional(Type.Boolean()),
  lines: Type.Optional(Type.Array(Type.String())),
  lines_truncated: Type.Optional(Type.Boolean()),
  raw_truncated: Type.Optional(Type.Boolean()),
  bytes: Type.Optional(Type.Number()),
  events: Type.Optional(Type.Number()),
  unparsed: Type.Optional(Type.Number()),
});

/**
 * A repository's record in a checkpoint's meta: the task's start and end commits, and what changed
 * between them; each file is kept when it reads as a changed file.
 */
const CheckpointRepository = Type.Object({
  start_sha: Type.Optional(Type.String()),
  end_sha: Type.Optional(Type.String()),
  files_changed: Type.Optional(Type.Number()),
  insertions: Type.Optional(Type.Number()),
  deletions: Type.Optional(Type.Number()),
  files: Type.Optional(Type.Array(Type.Unknown())),
});
export type CheckpointRepository = Static<typeof CheckpointRepository>;

/** The run the harness ops run under: not interrupted mid-exec; the poll loop stops the harness itself. */
export function opsRun(run: ToolRun): ToolRun {
  return { ...run, cancel_event: null };
}

/** The id a check outside a `code_task` call runs under, named for the check. */
export function checkCallId(): string {
  return `harness_check_${Date.now()}`;
}

/** What a `guilds-harness` op is sent beside its name and call: the harness, and the fields of the op that takes them. */
export type HarnessOpFields = {
  harness: Harness;
  repository?: string;
  prompt?: string;
  session_id?: string;
  model?: string;
  effort?: Effort;
  offset?: number;
};

/** Runs one `guilds-harness` op for the call `callId` names on the machine. */
export async function harnessOp(ops: ToolRun, callId: string, op: string, args: HarnessOpFields): Promise<CodeResult> {
  return runCodeHelper(
    ops,
    createToolHooks(),
    { ...args, op, call_id: callId },
    { helper: HARNESS_HELPER, timeoutSeconds: HARNESS_OP_TIMEOUT_SECONDS },
  );
}

/** The raw event log the app reads of one `code_task` call, at most this much of it. */
export const HARNESS_LOG_MAX_BYTES = 256 * 1024;

/** One `code_task` call's kept event log: its progress lines, and its raw JSONL from the start. */
export type HarnessLog = {
  lines: string[];
  lines_truncated: boolean;
  raw: string;
  raw_truncated: boolean;
  /** The log's whole size in bytes. */
  bytes: number;
  events: number;
  /** Lines of the log that were not JSON. */
  unparsed: number;
};

/**
 * Reads the kept log of call `callId` of `run` with `guilds-harness log`, redacted with
 * `secrets`; null once the agent's home no longer keeps it.
 */
export async function readHarnessLog(
  run: ToolRun,
  harness: Harness,
  callId: string,
  secrets: Record<string, string>,
): Promise<HarnessLog | null> {
  const result = await runCodeHelper(
    run,
    createToolHooks(),
    { op: "log", call_id: callId, harness },
    { helper: HARNESS_HELPER, timeoutSeconds: HARNESS_OP_TIMEOUT_SECONDS, maxBytes: HARNESS_LOG_MAX_BYTES },
  );
  const meta = keepMatching(HarnessLogMeta, result.meta) ?? {};
  if (meta.missing === true) {
    return null;
  }
  return {
    lines: shownProgressLines(meta.lines ?? [], secrets),
    lines_truncated: meta.lines_truncated === true,
    raw: redact(result.text, secrets),
    raw_truncated: meta.raw_truncated === true,
    bytes: meta.bytes ?? 0,
    events: meta.events ?? 0,
    unparsed: meta.unparsed ?? 0,
  };
}

/** Takes the task's `start` or `end` checkpoint in `repository`; the repository's record, or empty when it fails. */
export async function checkpoint(
  run: ToolRun,
  callId: string,
  which: "start" | "end",
  repository: string,
): Promise<CheckpointRepository> {
  try {
    const result = await runCodeHelper(
      run,
      createToolHooks(),
      { op: "checkpoint", call_id: callId, which, task: callId, repositories: [repository] },
      { timeoutSeconds: CHECKPOINT_TIMEOUT_SECONDS },
    );
    const repositories = result.meta.repositories;
    const first = Array.isArray(repositories) ? repositories[0] : undefined;
    return first !== undefined && isObjectNode(first) ? (keepMatching(CheckpointRepository, first) ?? {}) : {};
  } catch (error) {
    writeLog("warn", errorMessage(error), { run_id: run.run_id, agent_id: run.agent_id, operation: "code_task.checkpoint" });
    return {};
  }
}

function clipProgressLine(line: string): string {
  return line.length <= PROGRESS_LINE_CHARS ? line : `${line.slice(0, PROGRESS_LINE_CHARS - 1)}…`;
}

/** Progress lines as the run view shows them: redacted, then clipped, so no secret is cut in two. */
export function shownProgressLines(lines: string[], secrets: Record<string, string>): string[] {
  return lines.map((line) => clipProgressLine(redact(line, secrets)));
}
