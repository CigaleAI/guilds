import { Type, type Static } from "typebox";
import { harnessLaunch } from "../coding/harness-models.js";
import type { Effort, Harness } from "../db/schema/index.js";
import { keepMatching } from "../lib/decode.js";
import { isObjectNode } from "../lib/json.js";
import { errorMessage, writeLog } from "../observability/log.js";
import { redact } from "../secrets/index.js";
import { HARNESS_HELPER, runCodeHelper, runCodeHelperFromFile, type CodeResult } from "./code.js";
import { createToolHooks, type CancelEvent, type ToolRun } from "./types.js";

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
 * CLI's exit code and error flag, whether it ended at its turn limit, its session and final
 * message, how many events it printed and how many lines were not JSON, and the end of its stderr
 * and its error text.
 */
export const HarnessExit = Type.Object({
  missing: Type.Optional(Type.Boolean()),
  exit_code: Type.Optional(Type.Union([Type.Number(), Type.Null()])),
  is_error: Type.Optional(Type.Boolean()),
  max_turns: Type.Optional(Type.Boolean()),
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
  system_prompt?: string;
  session_id?: string;
  model?: string;
  effort?: Effort;
  max_turns?: number;
  offset?: number;
  mcp_url?: string;
  mcp_token?: string;
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

/** Runs one `guilds-harness` op whose fields hold a credential, through a request file (`runCodeHelperFromFile`). */
async function harnessOpFromFile(ops: ToolRun, callId: string, op: string, args: HarnessOpFields): Promise<CodeResult> {
  return runCodeHelperFromFile(
    ops,
    createToolHooks(),
    { ...args, op, call_id: callId },
    { helper: HARNESS_HELPER, timeoutSeconds: HARNESS_OP_TIMEOUT_SECONDS },
  );
}

/** Waits `ms`, or until the run is cancelled. */
export async function pause(ms: number, cancel: CancelEvent | null): Promise<void> {
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

/** The `result` op's meta, which also clears the call's state once the harness exited; null when unread. */
export async function readResult(ops: ToolRun, callId: string, harness: Harness): Promise<HarnessExit | null> {
  const result = await harnessOp(ops, callId, "result", { harness }).catch(() => null);
  const exit = result === null ? null : (keepMatching(HarnessExit, result.meta) ?? {});
  return exit === null || exit.missing === true ? null : exit;
}

/** Stops the harness and, once it has exited, reads its result. A call with no state left has nothing to stop. */
export async function stopHarness(
  ops: ToolRun,
  callId: string,
  harness: Harness,
): Promise<{ stopped: boolean; result: HarnessExit | null }> {
  const stop = await harnessOp(ops, callId, "stop", { harness }).catch(() => null);
  const stopped = stop !== null && keepMatching(HarnessStop, stop.meta)?.exited !== false;
  return { stopped, result: stopped ? await readResult(ops, callId, harness) : null };
}

/**
 * The orchestrator's MCP server a harness turn is given: the URL that serves its agent's tools,
 * and the bearer token it is served on while its generation runs.
 */
export type HarnessMcpAccess = { url: string; token: string };

/**
 * What a harness CLI is started with: the harness, the prompt it reads on stdin or from its file,
 * the repository it runs in (null for the agent's home), the system prompt it runs on, in place of
 * its own or as rules beside it, the orchestrator's MCP server it is given (null for none), the
 * session it resumes, the model and effort the agent sets for it, each null to leave it to the
 * harness, and the most model calls its turn may make, null for no limit.
 */
export type HarnessStart = {
  harness: Harness;
  prompt: string;
  repository: string | null;
  system_prompt: string | null;
  mcp: HarnessMcpAccess | null;
  session_id: string | null;
  model: string | null;
  effort: Effort | null;
  max_turns: number | null;
};

/**
 * Starts the harness CLI for the call `callId` names on the machine, under the model name and
 * effort the CLI takes. A start that gives it the MCP server travels through a request file, so
 * the token is on no command line.
 */
export async function launchHarness(ops: ToolRun, callId: string, start: HarnessStart): Promise<void> {
  const launch = harnessLaunch(start.harness, start.model, start.effort);
  const repository = start.repository ? { repository: start.repository } : {};
  const system = start.system_prompt ? { system_prompt: start.system_prompt } : {};
  const resume = start.session_id ? { session_id: start.session_id } : {};
  const model = launch.model ? { model: launch.model } : {};
  const effort = launch.effort ? { effort: launch.effort } : {};
  const maxTurns = start.max_turns === null ? {} : { max_turns: start.max_turns };
  const fields: HarnessOpFields = {
    harness: start.harness,
    prompt: start.prompt,
    ...repository,
    ...system,
    ...resume,
    ...model,
    ...effort,
    ...maxTurns,
  };
  if (start.mcp === null) {
    await harnessOp(ops, callId, "start", fields);
    return;
  }
  await harnessOpFromFile(ops, callId, "start", { ...fields, mcp_url: start.mcp.url, mcp_token: start.mcp.token });
}

/** One poll of a running harness: what the `poll` op says, and the raw JSONL events it read past the offset. */
export type HarnessPollResult = { poll: HarnessPoll; events: string };

/** One `poll` of the call `callId` names, from the log's byte `offset`. */
export async function pollHarness(
  ops: ToolRun,
  callId: string,
  harness: Harness,
  offset: number,
): Promise<HarnessPollResult> {
  const result = await harnessOp(ops, callId, "poll", { harness, offset });
  return { poll: keepMatching(HarnessPoll, result.meta) ?? {}, events: result.text };
}

/** Where the event log of the call `callId` of run `runId` is kept, under the agent's home. */
export function harnessLogPath(runId: string, callId: string): string {
  return `.runs/${runId}/${callId}.harness.jsonl`;
}

/** Consecutive failed polls after which a harness is stopped and its turn ends. */
export const HARNESS_POLL_FAILURES_MAX = 3;

/**
 * How a turn's poll loop ended: the harness exited on its own, its state was gone, it was
 * cancelled or ran past its timeout, it stopped answering polls, or the run was cancelled before
 * it started.
 */
export type Settled = "exited" | "missing" | "cancelled" | "timed_out" | "unresponsive" | "not_started";

/** How a turn ended: `stopped` is null when the harness was not stopped; `result` is the `result` op's meta once read. */
export type TurnEnding = {
  settled: Settled | "unreadable";
  stopped: boolean | null;
  result: HarnessExit | null;
};

/**
 * How the turn of the call `callId` names ends once its poll loop `settled`: a harness that
 * exited has its result read, one whose state is gone has nothing left, and any other is stopped.
 */
export async function endHarnessTurn(
  ops: ToolRun,
  callId: string,
  harness: Harness,
  settled: Settled,
): Promise<TurnEnding> {
  if (settled === "missing") {
    return { settled, stopped: null, result: null };
  }
  if (settled === "exited") {
    const result = await readResult(ops, callId, harness);
    return { settled: result === null ? "unreadable" : "exited", stopped: null, result };
  }
  return { settled, ...(await stopHarness(ops, callId, harness)) };
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
