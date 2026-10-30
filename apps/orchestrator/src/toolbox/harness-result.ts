import { Buffer } from "node:buffer";
import { isPlainRecord } from "../db/json.js";
import type { Harness } from "../db/schema/index.js";
import { codeResultMaxBytes } from "./code.js";
import { numberOrZero } from "./harness-ops.js";

const FILES_SHOWN = 30;

export type CodeTaskStatus = "completed" | "failed" | "timed_out" | "cancelled" | "interrupted";

export function formatDuration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  if (hours) {
    return `${hours}h${String(minutes % 60).padStart(2, "0")}m`;
  }
  return minutes ? `${minutes}m${String(seconds % 60).padStart(2, "0")}s` : `${seconds}s`;
}

export type ChangedFile = { path: string; insertions: number | null; deletions: number | null };

function isCount(value: unknown): value is number | null {
  return value === null || typeof value === "number";
}

/** Whether `value` is a file of a checkpoint's change list: its path, and its line counts or null for a binary file. */
export function isChangedFile(value: unknown): value is ChangedFile {
  return isPlainRecord(value) && typeof value.path === "string" && isCount(value.insertions) && isCount(value.deletions);
}

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

function changeSummary(outcome: CodeTaskOutcome): string {
  if (!outcome.files_changed) {
    return "no files changed";
  }
  const plural = outcome.files_changed === 1 ? "" : "s";
  return `${outcome.files_changed} file${plural} changed, +${outcome.insertions} −${outcome.deletions}`;
}

function fileLine(file: ChangedFile): string {
  const counts = file.insertions === null ? "binary" : `+${file.insertions} −${file.deletions ?? 0}`;
  return `${file.path} (${counts})`;
}

/** The first changed files, and how many more there are. */
function fileLines(outcome: CodeTaskOutcome): string[] {
  const shown = outcome.files.slice(0, FILES_SHOWN).map(fileLine);
  const more = outcome.files_changed - shown.length;
  return more > 0 ? [...shown, `… ${more} more files`] : shown;
}

/** The result the agent reads, within `maxBytes`; the final message gives way first, from its start. */
export function codeTaskText(outcome: CodeTaskOutcome, maxBytes = codeResultMaxBytes()): string {
  const title = `${outcome.status} · ${outcome.harness} · ${outcome.repository} · session ${outcome.session_id ?? "none"} · ${formatDuration(outcome.duration_ms)}`;
  const head = [title, changeSummary(outcome), ...fileLines(outcome), outcome.detail].filter(Boolean).join("\n");
  const tail = `log: ${outcome.log_path}`;
  const budget = maxBytes - Buffer.byteLength(`${head}\n\n\n\n${tail}`, "utf8") - 16;
  const message = keepEnd(outcome.message.trim() || "(no final message)", Math.max(0, budget));
  return `${head}\n\n${message}\n\n${tail}`;
}

/** A `code_task` call the orchestrator never saw finish: where it ran, its session and log, and whether its harness was stopped. */
export type InterruptedTask = {
  harness: Harness;
  repository: string | null;
  session_id: string | null;
  log_path: string | null;
  run_id: string;
  call_id: string;
  stopped: boolean;
};

/** The result of a call the orchestrator never saw finish: it restarted while the harness ran. */
export function interruptedText(task: InterruptedTask): string {
  const resume = task.session_id ? " Resume the session to finish the work." : "";
  return [
    `interrupted · ${task.harness} · ${task.repository ?? "unknown"} · session ${task.session_id ?? "none"}`,
    task.stopped
      ? "The harness was stopped before it finished: the orchestrator or the machine restarted."
      : "The orchestrator restarted, and the harness did not stop: it may still be running.",
    "The working tree holds whatever it wrote, and the task's start checkpoint stays at",
    `refs/guild/runs/${task.run_id}/tasks/${task.call_id}/start.${resume}`,
    "",
    `log: ${task.log_path ?? "none"}`,
  ].join("\n");
}

function stderrTail(value: unknown): string {
  return typeof value === "string" ? value.trim().split("\n").slice(-5).join("\n") : "";
}

function firstLine(value: unknown): string {
  return typeof value === "string" ? (value.split("\n")[0] ?? "") : "";
}

/** Why a turn failed. A CLI that printed no event, such as one refusing to start without a login, says why on stderr. */
export function failureDetail(harness: Harness, result: Record<string, unknown>, version: string | null): string {
  const events = numberOrZero(result.events);
  if (events === 0 && numberOrZero(result.unparsed) > 0) {
    return `error: the ${harness} driver does not parse this CLI's output (${version ?? "unknown version"})`;
  }
  const stderr = stderrTail(result.stderr);
  const error = firstLine(result.error);
  const reasons = events === 0 ? [stderr, error] : [error, stderr];
  return `error: ${reasons.find(Boolean) ?? `exited with code ${String(result.exit_code ?? "unknown")}`}`;
}
