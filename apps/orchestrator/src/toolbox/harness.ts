import { harnessLaunch } from "../coding/harness-models.js";
import type { Harness } from "../db/schema/index.js";
import { errorMessage, writeLog } from "../observability/log.js";
import { callSegment, type CodeResult } from "./code.js";
import { buildBrief } from "./harness-brief.js";
import { checkpoint, harnessOp, numberOrZero, opsRun, shownProgressLines, stringOrNull } from "./harness-ops.js";
import { codeTaskText, failureDetail, isChangedFile, type CodeTaskOutcome, type CodeTaskStatus } from "./harness-result.js";
import { checkHarness, requiredHarness } from "./harness-setup.js";
import { functionSchema } from "./schema.js";
import { identityOutput } from "./output.js";
import type { ToolServices } from "./services.js";
import {
  callActor,
  type CancelEvent,
  type Tool,
  type ToolHooks,
  type ToolInvocation,
  type ToolRun,
} from "./types.js";
import { ToolArgumentError, ToolUnavailableError } from "./errors.js";

export const HARNESS_TOOLS = ["code_task"] as const;
export const CODE_TASK_DEFAULT_MINUTES = 30;
export const CODE_TASK_MAX_MINUTES = 60;
/** How often a running call is polled, and how long its minutes are; tests shorten both. */
export const harnessTiming = { pollMs: 3000, minuteMs: 60_000 };
/** Consecutive failed polls after which the harness is stopped and the call ends `interrupted`. */
const POLL_FAILURES_MAX = 3;

// --- the call's arguments ---------------------------------------------------

function repositoryFor(run: ToolRun, args: Record<string, unknown>): string {
  const names = run.code_repositories;
  if (!names.length) {
    throw new ToolUnavailableError("this guild has no repositories; the operator adds them in the guild's Repositories");
  }
  const named = typeof args.repo === "string" ? args.repo.trim() : "";
  if (named) {
    return knownRepository(names, named);
  }
  if (names.length === 1) {
    return names[0]!;
  }
  throw new ToolArgumentError(`repo is required: the guild's repositories are ${names.join(", ")}`);
}

function knownRepository(names: string[], named: string): string {
  if (!names.includes(named)) {
    throw new ToolArgumentError(`unknown repository ${named}; the guild's repositories are ${names.join(", ")}`);
  }
  return named;
}

/** The call's timeout in whole minutes: 30 when not given, between 1 and 60. */
export function timeoutMinutes(args: Record<string, unknown>): number {
  const raw = args.timeout_minutes;
  const value = typeof raw === "number" && Number.isFinite(raw) ? Math.trunc(raw) : CODE_TASK_DEFAULT_MINUTES;
  return Math.max(1, Math.min(CODE_TASK_MAX_MINUTES, value));
}

/** The distinct display paths `notes` names; throws when it is not a list of strings. */
export function notePaths(args: Record<string, unknown>): string[] {
  const raw = args.notes;
  if (raw === undefined || raw === null) {
    return [];
  }
  if (!Array.isArray(raw) || !raw.every((item): item is string => typeof item === "string")) {
    throw new ToolArgumentError("notes must be a list of display paths");
  }
  return [...new Set(raw.map((item) => item.trim()).filter(Boolean))];
}

function requiredBrief(args: Record<string, unknown>): string {
  const brief = typeof args.brief === "string" ? args.brief : "";
  if (!brief.trim()) {
    throw new ToolArgumentError("brief is required");
  }
  return brief;
}

// --- one turn of the harness -----------------------------------------------

/** One `code_task` call: what it runs, and what the poll loop has seen so far. */
type HarnessTurn = {
  harness: Harness;
  repository: string;
  minutes: number;
  prompt: string;
  version: string | null;
  /** The run the harness ops run under. */
  ops: ToolRun;
  /** The id that names the call's state on the machine. */
  call_id: string;
  /** The provider id of the call, which its progress is published under. */
  tool_call_id: string;
  log_path: string;
  start_sha: string | null;
  started: number;
  deadline: number;
  session: string | null;
  offset: number;
  failures: number;
};

/**
 * How the poll loop ended: the harness exited on its own, its state was gone, it was cancelled
 * or ran past its timeout, it stopped answering polls, or the run was cancelled before it started.
 */
type Settled = "exited" | "missing" | "cancelled" | "timed_out" | "unresponsive" | "not_started";

/** How a turn ended: `stopped` is null when the harness was not stopped; `result` is the `result` op's meta once read. */
type TurnEnding = {
  settled: Settled | "unreadable";
  stopped: boolean | null;
  result: Record<string, unknown> | null;
};

const NOT_STARTED: TurnEnding = { settled: "not_started", stopped: null, result: null };

const SETTLED_STATUS: Record<Exclude<TurnEnding["settled"], "exited">, CodeTaskStatus> = {
  missing: "interrupted",
  unreadable: "interrupted",
  unresponsive: "interrupted",
  cancelled: "cancelled",
  not_started: "cancelled",
  timed_out: "timed_out",
};

const SETTLED_DETAIL: Record<TurnEnding["settled"], (minutes: number) => string> = {
  exited: () => "",
  missing: () => "The harness's state is gone: the machine restarted or its container was recreated.",
  unreadable: () => "The harness exited, and its result could not be read.",
  unresponsive: () => "The harness stopped answering, so it was stopped. Resume the session to continue.",
  cancelled: () => "Stopped: the generation was cancelled.",
  not_started: () => "The generation was cancelled before the harness started.",
  timed_out: (minutes) => `Stopped after ${minutes} minutes. Resume the session to continue.`,
};

type CheckedCall = Pick<HarnessTurn, "harness" | "repository" | "prompt" | "version" | "ops" | "call_id">;

function sessionIdOf(args: Record<string, unknown>): string | null {
  return typeof args.session_id === "string" ? stringOrNull(args.session_id.trim()) : null;
}

/** Validates the call's arguments, checks its harness, and builds the brief. */
async function checkedCall(services: ToolServices, run: ToolRun, call: ToolInvocation): Promise<CheckedCall> {
  const args = call.arguments;
  const harness = requiredHarness(run);
  const brief = requiredBrief(args);
  const repository = repositoryFor(run, args);
  const notes = notePaths(args);
  const callId = callSegment(call.id || `code_task_${Date.now()}`);
  const version = await checkHarness(services, run, callId, harness);
  const prompt = await buildBrief(services, callActor(run.artifact_actor, call), brief, notes);
  return { harness, repository, prompt, version, ops: opsRun(run), call_id: callId };
}

/** A checked call, with the task's start checkpoint taken and its clock started. */
async function openHarnessTurn(services: ToolServices, run: ToolRun, call: ToolInvocation): Promise<HarnessTurn> {
  const args = call.arguments;
  const checked = await checkedCall(services, run, call);
  const start = await checkpoint(checked.ops, checked.call_id, "start", checked.repository);
  const minutes = timeoutMinutes(args);
  const started = Date.now();
  return {
    ...checked,
    tool_call_id: call.id,
    minutes,
    log_path: displayLogPath(run.run_id, checked.call_id),
    start_sha: stringOrNull(start.start_sha),
    started,
    deadline: started + minutes * harnessTiming.minuteMs,
    session: sessionIdOf(args),
    offset: 0,
    failures: 0,
  };
}

async function rememberTurn(services: ToolServices, run: ToolRun, turn: HarnessTurn): Promise<void> {
  const task = {
    call_id: turn.call_id,
    harness: turn.harness,
    repository: turn.repository,
    session_id: turn.session,
    log_path: turn.log_path,
  };
  await services.db?.mergeRunMetadata(run.run_id, { harness_task: task }, new Date());
}

async function startHarness(services: ToolServices, run: ToolRun, hooks: ToolHooks, turn: HarnessTurn): Promise<void> {
  const resume = turn.session ? { session_id: turn.session } : {};
  await hooks.before_command?.();
  const launch = harnessLaunch(turn.harness, run.harness_model, run.harness_effort);
  const model = launch.model ? { model: launch.model } : {};
  const effort = launch.effort ? { effort: launch.effort } : {};
  await harnessOp(turn.ops, turn.call_id, "start", {
    harness: turn.harness,
    repository: turn.repository,
    prompt: turn.prompt,
    ...resume,
    ...model,
    ...effort,
  });
  await rememberTurn(services, run, turn);
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

function interruption(run: ToolRun, turn: HarnessTurn): Settled | null {
  if (run.cancel_event?.aborted) {
    return "cancelled";
  }
  return Date.now() >= turn.deadline ? "timed_out" : null;
}

function countFailedPoll(turn: HarnessTurn, error: unknown): Settled | null {
  turn.failures += 1;
  if (turn.failures < POLL_FAILURES_MAX) {
    return null;
  }
  writeLog("warn", errorMessage(error), { run_id: turn.ops.run_id, agent_id: turn.ops.agent_id, operation: "code_task.poll" });
  return "unresponsive";
}

async function noteSession(services: ToolServices, run: ToolRun, turn: HarnessTurn, seen: unknown): Promise<void> {
  if (typeof seen !== "string" || !seen || seen === turn.session) {
    return;
  }
  turn.session = seen;
  await rememberTurn(services, run, turn);
}

async function publishLines(services: ToolServices, run: ToolRun, turn: HarnessTurn, lines: unknown): Promise<void> {
  if (!Array.isArray(lines) || !lines.length) {
    return;
  }
  await services.events?.publish(run.run_id, "tool.progress", {
    run_id: run.run_id,
    tool_call_id: turn.tool_call_id,
    lines: shownProgressLines(lines.map(String), run.secrets),
    session_id: turn.session,
  });
}

async function applyPoll(
  services: ToolServices,
  run: ToolRun,
  turn: HarnessTurn,
  meta: Record<string, unknown>,
): Promise<Settled | null> {
  if (meta.missing === true) {
    return "missing";
  }
  turn.offset = typeof meta.offset === "number" ? meta.offset : turn.offset;
  await noteSession(services, run, turn, meta.session_id);
  await publishLines(services, run, turn, meta.lines);
  return meta.exited === true ? "exited" : null;
}

async function pollOnce(services: ToolServices, run: ToolRun, hooks: ToolHooks, turn: HarnessTurn): Promise<Settled | null> {
  let poll: CodeResult;
  try {
    await hooks.before_command?.();
    poll = await harnessOp(turn.ops, turn.call_id, "poll", { harness: turn.harness, offset: turn.offset });
  } catch (error) {
    return countFailedPoll(turn, error);
  }
  turn.failures = 0;
  return applyPoll(services, run, turn, poll.meta);
}

/** Polls the harness, publishing its progress, until it exits, is lost, or must be stopped. */
async function pollUntilSettled(services: ToolServices, run: ToolRun, hooks: ToolHooks, turn: HarnessTurn): Promise<Settled> {
  for (;;) {
    const settled = interruption(run, turn) ?? (await pollOnce(services, run, hooks, turn));
    if (settled !== null) {
      return settled;
    }
    await pause(Math.min(harnessTiming.pollMs, Math.max(0, turn.deadline - Date.now())), run.cancel_event);
  }
}

/** The `result` op's meta, which also clears the call's state once the harness exited; null when unread. */
async function readResult(ops: ToolRun, callId: string, harness: Harness): Promise<Record<string, unknown> | null> {
  const result = await harnessOp(ops, callId, "result", { harness }).catch(() => null);
  return result === null || result.meta.missing === true ? null : result.meta;
}

/** Stops the harness and, once it has exited, reads its result. A call with no state left has nothing to stop. */
async function stopHarness(
  ops: ToolRun,
  callId: string,
  harness: Harness,
): Promise<{ stopped: boolean; result: Record<string, unknown> | null }> {
  const stop = await harnessOp(ops, callId, "stop", { harness }).catch(() => null);
  const stopped = stop !== null && stop.meta.exited !== false;
  return { stopped, result: stopped ? await readResult(ops, callId, harness) : null };
}

async function endTurn(turn: HarnessTurn, settled: Settled): Promise<TurnEnding> {
  if (settled === "missing") {
    return { settled, stopped: null, result: null };
  }
  if (settled === "exited") {
    const result = await readResult(turn.ops, turn.call_id, turn.harness);
    return { settled: result === null ? "unreadable" : "exited", stopped: null, result };
  }
  return { settled, ...(await stopHarness(turn.ops, turn.call_id, turn.harness)) };
}

/** Starts the harness and polls it to the end; from `start` on, any way out but a clean exit or lost state stops it. */
async function runHarnessTurn(services: ToolServices, run: ToolRun, hooks: ToolHooks, turn: HarnessTurn): Promise<TurnEnding> {
  let settled: Settled;
  try {
    await startHarness(services, run, hooks, turn);
    settled = await pollUntilSettled(services, run, hooks, turn);
  } catch (error) {
    await stopHarness(turn.ops, turn.call_id, turn.harness);
    throw error;
  }
  return endTurn(turn, settled);
}

/** What the machine says about a call the orchestrator lost track of when it restarted. */
export type LostTurnEnd = {
  stopped: boolean;
  session_id: string | null;
  start_sha: string | null;
  end_sha: string | null;
};

/**
 * Stops a call the orchestrator lost track of, clears its state once the harness exited, and
 * takes the task's end checkpoint in `repository` when it is known. `callId` names the call.
 */
export async function endLostTurn(
  run: ToolRun,
  callId: string,
  harness: Harness,
  repository: string | null,
): Promise<LostTurnEnd> {
  const { stopped, result } = await stopHarness(run, callId, harness);
  const end = repository ? await checkpoint(run, callId, "end", repository) : {};
  return {
    stopped,
    session_id: stringOrNull(result?.session_id),
    start_sha: stringOrNull(end.start_sha),
    end_sha: stringOrNull(end.end_sha),
  };
}

function displayLogPath(runId: string, callId: string): string {
  return `.runs/${runId}/${callId}.harness.jsonl`;
}

function endingStatus(ending: TurnEnding): CodeTaskStatus {
  if (ending.settled !== "exited") {
    return SETTLED_STATUS[ending.settled];
  }
  return ending.result?.exit_code === 0 && ending.result.is_error !== true ? "completed" : "failed";
}

function endingDetail(turn: HarnessTurn, ending: TurnEnding, status: CodeTaskStatus): string {
  if (ending.stopped === false) {
    return `The harness did not stop and may still be running; its log is ${turn.log_path}.`;
  }
  if (status === "failed") {
    return failureDetail(turn.harness, ending.result ?? {}, turn.version);
  }
  return SETTLED_DETAIL[ending.settled](turn.minutes);
}

function turnOutcome(turn: HarnessTurn, ending: TurnEnding, changed: Record<string, unknown>): CodeTaskOutcome {
  const status = endingStatus(ending);
  return {
    status,
    harness: turn.harness,
    repository: turn.repository,
    session_id: stringOrNull(ending.result?.session_id) ?? turn.session,
    duration_ms: Date.now() - turn.started,
    files_changed: numberOrZero(changed.files_changed),
    insertions: numberOrZero(changed.insertions),
    deletions: numberOrZero(changed.deletions),
    files: Array.isArray(changed.files) ? changed.files.filter(isChangedFile) : [],
    detail: endingDetail(turn, ending, status),
    message: stringOrNull(ending.result?.message) ?? "",
    log_path: turn.log_path,
  };
}

/** Takes the task's end checkpoint, and records and returns what the agent reads. */
async function finishHarnessTurn(call: ToolInvocation, turn: HarnessTurn, ending: TurnEnding): Promise<string> {
  const end = await checkpoint(turn.ops, turn.call_id, "end", turn.repository);
  const outcome = turnOutcome(turn, ending, end);
  const exitCode = typeof ending.result?.exit_code === "number" ? ending.result.exit_code : null;
  call.exit_code = exitCode;
  call.metadata = {
    harness: turn.harness,
    status: outcome.status,
    session_id: outcome.session_id,
    repository: turn.repository,
    exit_code: exitCode,
    files_changed: outcome.files_changed,
    insertions: outcome.insertions,
    deletions: outcome.deletions,
    start_sha: turn.start_sha ?? stringOrNull(end.start_sha),
    end_sha: stringOrNull(end.end_sha),
    log_path: turn.log_path,
  };
  return codeTaskText(outcome);
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
  async handler(services, run, hooks, call) {
    const turn = await openHarnessTurn(services, run, call);
    const ending = run.cancel_event?.aborted ? NOT_STARTED : await runHarnessTurn(services, run, hooks, turn);
    return finishHarnessTurn(call, turn, ending);
  },
};