import { Buffer } from "node:buffer";
import { credentialFix, HARNESS_INFO, harnessesOn, harnessOffMessage, isHarnessOff } from "../coding/harnesses.js";
import { harnessLaunch } from "../coding/harness-models.js";
import type { Harness } from "../db/schema/index.js";
import { writeLog } from "../observability/log.js";
import { redact } from "../secrets/index.js";
import { readArtifactText } from "./artifacts.js";
import { callSegment, codeResultMaxBytes, HARNESS_HELPER, runCodeHelper, type CodeResult } from "./code.js";
import { functionSchema } from "./schema.js";
import { identityOutput } from "./output.js";
import type { CancelEvent, Tool, ToolContext, ToolInvocation } from "./types.js";

export const HARNESS_TOOLS = ["code_task"] as const;
export const CODE_TASK_DEFAULT_MINUTES = 30;
export const CODE_TASK_MAX_MINUTES = 60;
/** How often a running call is polled, and how long its minutes are; tests shorten both. */
export const harnessTiming = { pollMs: 3000, minuteMs: 60_000 };
/** The content of `notes` appended to a brief, at most. */
export const BRIEF_NOTES_MAX_BYTES = 64 * 1024;
const HARNESS_OP_TIMEOUT_SECONDS = 60;
const CHECKPOINT_TIMEOUT_SECONDS = 300;
/** Consecutive failed polls after which the harness is stopped and the call ends `interrupted`. */
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

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value ? value : null;
}

function count(value: unknown): number {
  return Number(value ?? 0) || 0;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The context the harness ops run under: not interrupted mid-exec; the poll loop stops the harness itself. */
function opsContext(ctx: ToolContext): ToolContext {
  return { ...ctx, cancel_event: null, track_command: null };
}

/** The id a check outside a `code_task` call runs under, named for the check. */
function checkCallId(): string {
  return `harness_check_${Date.now()}`;
}

/** Runs one `guilds-harness` op for the call `callId` names on the machine. */
async function harnessOp(ops: ToolContext, callId: string, op: string, args: Record<string, unknown>): Promise<CodeResult> {
  return runCodeHelper(
    ops,
    { ...args, op, call_id: callId },
    { helper: HARNESS_HELPER, timeoutSeconds: HARNESS_OP_TIMEOUT_SECONDS },
  );
}

// --- the call's arguments ---------------------------------------------------

function repositoryFor(ctx: ToolContext, args: Record<string, unknown>): string {
  const names = ctx.code_repositories;
  if (!names.length) {
    throw new Error("this guild has no repositories; the operator adds them in the guild's Repositories");
  }
  const named = typeof args.repo === "string" ? args.repo.trim() : "";
  if (named) {
    return knownRepository(names, named);
  }
  if (names.length === 1) {
    return names[0]!;
  }
  throw new Error(`repo is required: the guild's repositories are ${names.join(", ")}`);
}

function knownRepository(names: string[], named: string): string {
  if (!names.includes(named)) {
    throw new Error(`unknown repository ${named}; the guild's repositories are ${names.join(", ")}`);
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
  if (!Array.isArray(raw) || raw.some((item) => typeof item !== "string")) {
    throw new Error("notes must be a list of display paths");
  }
  return [...new Set((raw as string[]).map((item) => item.trim()).filter(Boolean))];
}

function requiredBrief(args: Record<string, unknown>): string {
  const brief = typeof args.brief === "string" ? args.brief : "";
  if (!brief.trim()) {
    throw new Error("brief is required");
  }
  return brief;
}

function requiredHarness(ctx: ToolContext): Harness {
  if (ctx.harness === null) {
    throw harnessMissingError();
  }
  if (isHarnessOff(ctx.harness)) {
    throw new HarnessSetupError("harness.off", harnessOffMessage(ctx.harness));
  }
  return ctx.harness;
}

// --- the brief ----------------------------------------------------------------

type NoteSection = { path: string; section: string };
type FittedNotes = { used: number; included: string[]; left: string[] };

async function loadNote(ctx: ToolContext, call: ToolInvocation, path: string): Promise<NoteSection> {
  try {
    const loaded = await readArtifactText(ctx, call, path);
    return { path: loaded.path, section: `# ${loaded.path}\n\n${loaded.text.trim()}` };
  } catch (error) {
    throw new Error(`notes: ${path}: ${errorText(error)}`, { cause: error });
  }
}

function addNote(fitted: FittedNotes, note: NoteSection): void {
  const size = Buffer.byteLength(note.section, "utf8");
  if (fitted.used + size > BRIEF_NOTES_MAX_BYTES) {
    fitted.left.push(note.path);
    return;
  }
  fitted.used += size;
  fitted.included.push(note.section);
}

/** The fixed preamble, the brief, and each note in order while the notes fit their cap. */
export function briefText(brief: string, notes: NoteSection[]): string {
  const fitted: FittedNotes = { used: 0, included: [], left: [] };
  notes.forEach((note) => addNote(fitted, note));
  const parts = [BRIEF_PREAMBLE, `# Task\n\n${brief.trim()}`, ...fitted.included];
  if (fitted.left.length) {
    parts.push(`Not included, past the ${BRIEF_NOTES_MAX_BYTES / 1024} KiB cap for notes: ${fitted.left.join(", ")}`);
  }
  return parts.join("\n\n") + "\n";
}

/** The brief the harness reads, with each note under its display path; a note that does not load fails the call. */
export async function buildBrief(
  ctx: ToolContext,
  call: ToolInvocation,
  brief: string,
  paths: string[],
): Promise<string> {
  const notes: NoteSection[] = [];
  for (const path of paths) {
    notes.push(await loadNote(ctx, call, path));
  }
  return briefText(brief, notes);
}

// --- checks before the harness starts --------------------------------------

/** Why a harness cannot run: none is picked, its CLI is missing from the image, or it has no credential. */
export class HarnessSetupError extends Error {
  constructor(
    readonly code: "harness.missing" | "harness.off" | "harness.not_installed" | "harness.credential",
    message: string,
  ) {
    super(message);
    this.name = "HarnessSetupError";
  }
}

/** What a coding run or a `code_task` call of an agent with no harness picked fails with. */
export function harnessMissingError(): HarnessSetupError {
  const labels = harnessesOn().map((harness) => HARNESS_INFO[harness].label);
  const choices = labels.length > 1 ? `${labels.slice(0, -1).join(", ")}, or ${labels.at(-1)}` : labels.join("");
  return new HarnessSetupError("harness.missing", `no harness is picked: choose ${choices} in the agent's Settings`);
}

function assertInstalled(harness: Harness, meta: Record<string, unknown>): void {
  if (meta.installed === true) {
    return;
  }
  const fix =
    harness === "codex"
      ? "rebuild the runtime image, which always installs it"
      : `build the runtime image with HARNESSES naming ${harness}`;
  throw new HarnessSetupError(
    "harness.not_installed",
    `${HARNESS_INFO[harness].label} is not installed in this machine's image: ${fix}`,
  );
}

async function assertCredential(ctx: ToolContext, harness: Harness, meta: Record<string, unknown>): Promise<void> {
  if (meta.credential === "login") {
    await ctx.db?.markHarnessLogin(ctx.agent_id, harness, new Date(), stringOrNull(meta.account));
  } else if (meta.credential !== "secret") {
    await ctx.db?.clearHarnessLogin(ctx.agent_id, harness);
    throw new HarnessSetupError(
      "harness.credential",
      `${HARNESS_INFO[harness].label} has no credential: ${credentialFix(harness, ctx.secret_aliases)}`,
    );
  }
}

/** Checks the harness's CLI is installed and has a credential; returns its version. */
async function checkHarness(
  ctx: ToolContext,
  ops: ToolContext,
  callId: string,
  harness: Harness,
): Promise<string | null> {
  const check = await harnessOp(ops, callId, "check", { harness });
  assertInstalled(harness, check.meta);
  await assertCredential(ctx, harness, check.meta);
  return stringOrNull(check.meta.version);
}

/**
 * Checks, before a coding generation calls its model, that the run's harness is installed and
 * has a credential, so a run that cannot delegate code work fails at start. Throws
 * `HarnessSetupError` naming the fix.
 */
export async function assertHarnessReady(ctx: ToolContext): Promise<void> {
  const harness = requiredHarness(ctx);
  await checkHarness(ctx, opsContext(ctx), checkCallId(), harness);
}

/** What a harness check found on the agent's machine. */
export type HarnessCheck = {
  installed: boolean;
  version: string | null;
  /** What the harness would run on: a granted secret, a login in the home, or nothing. */
  credential: "secret" | "login" | null;
  /** Whose the login is, as the harness recorded it; null without a login or when unknown. */
  account: string | null;
};

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
 * Reads the kept log of call `callId` of `ctx`'s run with `guilds-harness log`, redacted with
 * `secrets`; null once the agent's home no longer keeps it.
 */
export async function readHarnessLog(
  ctx: ToolContext,
  harness: Harness,
  callId: string,
  secrets: Record<string, string>,
): Promise<HarnessLog | null> {
  const result = await runCodeHelper(
    ctx,
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

/** Runs `guilds-harness check` for `harness` under `ctx`, outside any tool call. */
export async function checkHarnessOn(ctx: ToolContext, harness: Harness): Promise<HarnessCheck> {
  const check = await harnessOp(opsContext(ctx), checkCallId(), "check", { harness });
  const credential = check.meta.credential;
  return {
    installed: check.meta.installed === true,
    version: stringOrNull(check.meta.version),
    credential: credential === "secret" || credential === "login" ? credential : null,
    account: stringOrNull(check.meta.account),
  };
}

async function checkpoint(
  ctx: ToolContext,
  callId: string,
  which: "start" | "end",
  repository: string,
): Promise<Record<string, unknown>> {
  try {
    const result = await runCodeHelper(
      ctx,
      { op: "checkpoint", call_id: callId, which, task: callId, repositories: [repository] },
      { timeoutSeconds: CHECKPOINT_TIMEOUT_SECONDS },
    );
    const records = Array.isArray(result.meta.repositories) ? result.meta.repositories : [];
    return (records[0] as Record<string, unknown> | undefined) ?? {};
  } catch (error) {
    writeLog("warn", errorText(error), { run_id: ctx.run_id, agent_id: ctx.agent_id, operation: "code_task.checkpoint" });
    return {};
  }
}

// --- one turn of the harness -----------------------------------------------

/** One `code_task` call: what it runs, and what the poll loop has seen so far. */
type HarnessTurn = {
  harness: Harness;
  repository: string;
  minutes: number;
  prompt: string;
  version: string | null;
  /** The harness ops' context. */
  ops: ToolContext;
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
async function checkedCall(ctx: ToolContext, call: ToolInvocation): Promise<CheckedCall> {
  const args = call.arguments;
  const harness = requiredHarness(ctx);
  const brief = requiredBrief(args);
  const repository = repositoryFor(ctx, args);
  const notes = notePaths(args);
  const ops = opsContext(ctx);
  const callId = callSegment(call.id || `code_task_${Date.now()}`);
  const version = await checkHarness(ctx, ops, callId, harness);
  return { harness, repository, prompt: await buildBrief(ctx, call, brief, notes), version, ops, call_id: callId };
}

/** A checked call, with the task's start checkpoint taken and its clock started. */
async function openHarnessTurn(ctx: ToolContext, call: ToolInvocation): Promise<HarnessTurn> {
  const args = call.arguments;
  const checked = await checkedCall(ctx, call);
  const start = await checkpoint(checked.ops, checked.call_id, "start", checked.repository);
  const minutes = timeoutMinutes(args);
  const started = Date.now();
  return {
    ...checked,
    tool_call_id: call.id,
    minutes,
    log_path: displayLogPath(ctx.run_id, checked.call_id),
    start_sha: stringOrNull(start.start_sha),
    started,
    deadline: started + minutes * harnessTiming.minuteMs,
    session: sessionIdOf(args),
    offset: 0,
    failures: 0,
  };
}

async function rememberTurn(ctx: ToolContext, turn: HarnessTurn): Promise<void> {
  const task = {
    call_id: turn.call_id,
    harness: turn.harness,
    repository: turn.repository,
    session_id: turn.session,
    log_path: turn.log_path,
  };
  await ctx.db?.mergeRunMetadata(ctx.run_id, { harness_task: task }, new Date());
}

async function startHarness(ctx: ToolContext, turn: HarnessTurn): Promise<void> {
  const resume = turn.session ? { session_id: turn.session } : {};
  await ctx.before_command?.();
  const launch = harnessLaunch(turn.harness, ctx.harness_model, ctx.harness_effort);
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
  await rememberTurn(ctx, turn);
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

function interruption(ctx: ToolContext, turn: HarnessTurn): Settled | null {
  if (ctx.cancel_event?.aborted) {
    return "cancelled";
  }
  return Date.now() >= turn.deadline ? "timed_out" : null;
}

function countFailedPoll(turn: HarnessTurn, error: unknown): Settled | null {
  turn.failures += 1;
  if (turn.failures < POLL_FAILURES_MAX) {
    return null;
  }
  writeLog("warn", errorText(error), { run_id: turn.ops.run_id, agent_id: turn.ops.agent_id, operation: "code_task.poll" });
  return "unresponsive";
}

async function noteSession(ctx: ToolContext, turn: HarnessTurn, seen: unknown): Promise<void> {
  if (typeof seen !== "string" || !seen || seen === turn.session) {
    return;
  }
  turn.session = seen;
  await rememberTurn(ctx, turn);
}

async function publishLines(ctx: ToolContext, turn: HarnessTurn, lines: unknown): Promise<void> {
  if (!Array.isArray(lines) || !lines.length) {
    return;
  }
  await ctx.events?.publish(ctx.run_id, "tool.progress", {
    run_id: ctx.run_id,
    tool_call_id: turn.tool_call_id,
    lines: shownProgressLines(lines.map(String), ctx.secrets),
    session_id: turn.session,
  });
}

async function applyPoll(ctx: ToolContext, turn: HarnessTurn, meta: Record<string, unknown>): Promise<Settled | null> {
  if (meta.missing === true) {
    return "missing";
  }
  turn.offset = typeof meta.offset === "number" ? meta.offset : turn.offset;
  await noteSession(ctx, turn, meta.session_id);
  await publishLines(ctx, turn, meta.lines);
  return meta.exited === true ? "exited" : null;
}

async function pollOnce(ctx: ToolContext, turn: HarnessTurn): Promise<Settled | null> {
  let poll: CodeResult;
  try {
    await ctx.before_command?.();
    poll = await harnessOp(turn.ops, turn.call_id, "poll", { harness: turn.harness, offset: turn.offset });
  } catch (error) {
    return countFailedPoll(turn, error);
  }
  turn.failures = 0;
  return applyPoll(ctx, turn, poll.meta);
}

/** Polls the harness, publishing its progress, until it exits, is lost, or must be stopped. */
async function pollUntilSettled(ctx: ToolContext, turn: HarnessTurn): Promise<Settled> {
  for (;;) {
    const settled = interruption(ctx, turn) ?? (await pollOnce(ctx, turn));
    if (settled !== null) {
      return settled;
    }
    await pause(Math.min(harnessTiming.pollMs, Math.max(0, turn.deadline - Date.now())), ctx.cancel_event);
  }
}

/** The `result` op's meta, which also clears the call's state once the harness exited; null when unread. */
async function readResult(ops: ToolContext, callId: string, harness: Harness): Promise<Record<string, unknown> | null> {
  const result = await harnessOp(ops, callId, "result", { harness }).catch(() => null);
  return result === null || result.meta.missing === true ? null : result.meta;
}

/** Stops the harness and, once it has exited, reads its result. A call with no state left has nothing to stop. */
async function stopHarness(
  ops: ToolContext,
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
async function runHarnessTurn(ctx: ToolContext, turn: HarnessTurn): Promise<TurnEnding> {
  let settled: Settled;
  try {
    await startHarness(ctx, turn);
    settled = await pollUntilSettled(ctx, turn);
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
  ctx: ToolContext,
  callId: string,
  harness: Harness,
  repository: string | null,
): Promise<LostTurnEnd> {
  const { stopped, result } = await stopHarness(ctx, callId, harness);
  const end = repository ? await checkpoint(ctx, callId, "end", repository) : {};
  return {
    stopped,
    session_id: stringOrNull(result?.session_id),
    start_sha: stringOrNull(end.start_sha),
    end_sha: stringOrNull(end.end_sha),
  };
}

// --- the result ---------------------------------------------------------------

function clipProgressLine(line: string): string {
  return line.length <= PROGRESS_LINE_CHARS ? line : `${line.slice(0, PROGRESS_LINE_CHARS - 1)}…`;
}

/** Progress lines as the run view shows them: redacted, then clipped, so no secret is cut in two. */
export function shownProgressLines(lines: string[], secrets: Record<string, string>): string[] {
  return lines.map((line) => clipProgressLine(redact(line, secrets)));
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

/** The result of a call the orchestrator never saw finish: it restarted while the harness ran. */
export function interruptedText(task: {
  harness: Harness;
  repository: string | null;
  session_id: string | null;
  log_path: string | null;
  run_id: string;
  call_id: string;
  stopped: boolean;
}): string {
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

function displayLogPath(runId: string, callId: string): string {
  return `.runs/${runId}/${callId}.harness.jsonl`;
}

function stderrTail(value: unknown): string {
  return typeof value === "string" ? value.trim().split("\n").slice(-5).join("\n") : "";
}

function firstLine(value: unknown): string {
  return typeof value === "string" ? (value.split("\n")[0] ?? "") : "";
}

/** Why a turn failed. A CLI that printed no event, such as one refusing to start without a login, says why on stderr. */
export function failureDetail(harness: Harness, result: Record<string, unknown>, version: string | null): string {
  const events = count(result.events);
  if (events === 0 && count(result.unparsed) > 0) {
    return `error: the ${harness} driver does not parse this CLI's output (${version ?? "unknown version"})`;
  }
  const stderr = stderrTail(result.stderr);
  const error = firstLine(result.error);
  const reasons = events === 0 ? [stderr, error] : [error, stderr];
  return `error: ${reasons.find(Boolean) ?? `exited with code ${String(result.exit_code ?? "unknown")}`}`;
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
    files_changed: count(changed.files_changed),
    insertions: count(changed.insertions),
    deletions: count(changed.deletions),
    files: Array.isArray(changed.files) ? (changed.files as ChangedFile[]) : [],
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
  async handler(ctx, call) {
    const turn = await openHarnessTurn(ctx, call);
    const ending = ctx.cancel_event?.aborted ? NOT_STARTED : await runHarnessTurn(ctx, turn);
    return finishHarnessTurn(call, turn, ending);
  },
};
