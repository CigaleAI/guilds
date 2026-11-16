import { HARNESS_INFO } from "../coding/harnesses.js";
import type { Harness } from "../db/schema/index.js";
import { errorName, writeLog, type LogFields, type LogLevel } from "../observability/log.js";

/** The named errors a generation throws, and the failures it carries on past. */

/**
 * An operation that failed without failing the work around it, which carries on: the line the
 * failure is logged with, and what the operation threw.
 */
export type OperationFailure = { message: string; fields: LogFields; error: unknown };

/** Logs the failure at `level`, when there is one. */
export function logOperationFailure(failure: OperationFailure | null, level: LogLevel = "error"): void {
  if (failure === null) {
    return;
  }
  writeLog(level, failure.message, { ...failure.fields, error_type: errorName(failure.error) }, failure.error);
}

export class ConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConflictError";
  }
}

/**
 * The agent starts no generation while a blocking issue it reported is open. It is not busy: no
 * generation of its own will end and free it, only the issue's resolution.
 */
export class AgentDisabledError extends Error {
  constructor(summary: string) {
    super(`agent is disabled by a blocking issue: ${summary}. Resolve the issue first`);
    this.name = "AgentDisabledError";
  }
}

/** A tool call of the generation filed a blocking issue, which ends it. */
export class GenerationBlocked extends Error {
  constructor(issueId: string) {
    super(`the agent reported blocking issue ${issueId}; it is disabled until the issue is resolved`);
    this.name = "GenerationBlocked";
  }
}

/**
 * A run of a subscription agent on a harness whose CLI does not run a subscription agent's turns,
 * which fails at start.
 */
export class SubscriptionRunUnavailable extends Error {
  readonly code = "subscription.not_runnable";

  constructor(harness: Harness) {
    super(
      `${HARNESS_INFO[harness].label} cannot run a subscription agent's turns yet: pick Claude Code in the agent's Settings, or give the agent a model on a key`,
    );
    this.name = "SubscriptionRunUnavailable";
  }
}

/**
 * How a subscription agent's turn on its harness failed: the CLI did not start, it failed, its
 * state was lost, it stopped answering, or it ran past its time.
 */
export class HarnessTurnError extends Error {
  constructor(
    readonly code: "harness.start" | "harness.failed" | "harness.lost" | "harness.unresponsive" | "harness.timed_out",
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "HarnessTurnError";
  }
}

export class RunRequestError extends Error {
  status: number;
  detail: string;

  constructor(status: number, detail: string) {
    super(detail);
    this.name = "RunRequestError";
    this.status = status;
    this.detail = detail;
  }
}

/** Whether the error is an agent admitted no generation: it is busy, or a blocking issue disables it. */
export function isAdmissionRefusal(error: unknown): error is ConflictError | AgentDisabledError {
  return error instanceof ConflictError || error instanceof AgentDisabledError;
}

/** The agent a run belongs to was deleted while the run still worked for it. */
export class AgentGoneError extends Error {
  constructor() {
    super("agent not found");
    this.name = "AgentGoneError";
  }
}

export class GenerationCancelled extends Error {
  constructor(message = "cancelled") {
    super(message);
    this.name = "GenerationCancelled";
  }
}

/**
 * A request to the orchestrator's MCP server that holds no grant: no token, or one that is not
 * the token of the running generation of the agent its path names. It says nothing more.
 */
export class HarnessMcpRefused extends Error {
  constructor() {
    super("unauthorized");
    this.name = "HarnessMcpRefused";
  }
}

/** What a run that made its last tool call tells its model, and records as its run error. */
export const TOOL_CALL_LIMIT_MESSAGE = "Tool call limit reached. Start a new run to continue.";

export class RunLimitError extends Error {
  operation: string;

  constructor(operation: string, message: string) {
    super(message);
    this.name = "RunLimitError";
    this.operation = operation;
  }
}
