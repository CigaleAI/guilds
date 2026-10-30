import type { Harness } from "../db/schema/index.js";
import { errorMessage, writeLog } from "../observability/log.js";
import { redact } from "../secrets/index.js";
import { HARNESS_HELPER, runCodeHelper, type CodeResult } from "./code.js";
import { createToolHooks, type ToolRun } from "./types.js";

const HARNESS_OP_TIMEOUT_SECONDS = 60;
const CHECKPOINT_TIMEOUT_SECONDS = 300;
const PROGRESS_LINE_CHARS = 240;

/** A text field of an op's meta; null when it is absent or empty. */
export function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value ? value : null;
}

/** A count field of an op's meta; 0 when it is absent or not a number. */
export function numberOrZero(value: unknown): number {
  return Number(value ?? 0) || 0;
}

/** The run the harness ops run under: not interrupted mid-exec; the poll loop stops the harness itself. */
export function opsRun(run: ToolRun): ToolRun {
  return { ...run, cancel_event: null };
}

/** The id a check outside a `code_task` call runs under, named for the check. */
export function checkCallId(): string {
  return `harness_check_${Date.now()}`;
}

/** Runs one `guilds-harness` op for the call `callId` names on the machine. */
export async function harnessOp(ops: ToolRun, callId: string, op: string, args: Record<string, unknown>): Promise<CodeResult> {
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
  const meta = result.meta;
  if (meta.missing === true) {
    return null;
  }
  const lines = Array.isArray(meta.lines) ? meta.lines.map(String) : [];
  return {
    lines: shownProgressLines(lines, secrets),
    lines_truncated: meta.lines_truncated === true,
    raw: redact(result.text, secrets),
    raw_truncated: meta.raw_truncated === true,
    bytes: Number(meta.bytes) || 0,
    events: Number(meta.events) || 0,
    unparsed: Number(meta.unparsed) || 0,
  };
}

/** Takes the task's `start` or `end` checkpoint in `repository`; the repository's record, or empty when it fails. */
export async function checkpoint(
  run: ToolRun,
  callId: string,
  which: "start" | "end",
  repository: string,
): Promise<Record<string, unknown>> {
  try {
    const result = await runCodeHelper(
      run,
      createToolHooks(),
      { op: "checkpoint", call_id: callId, which, task: callId, repositories: [repository] },
      { timeoutSeconds: CHECKPOINT_TIMEOUT_SECONDS },
    );
    const records = Array.isArray(result.meta.repositories) ? result.meta.repositories : [];
    return (records[0] as Record<string, unknown> | undefined) ?? {};
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
