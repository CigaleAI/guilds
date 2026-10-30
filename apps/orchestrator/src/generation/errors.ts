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

export class RunLimitError extends Error {
  operation: string;

  constructor(operation: string, message: string) {
    super(message);
    this.name = "RunLimitError";
    this.operation = operation;
  }
}
