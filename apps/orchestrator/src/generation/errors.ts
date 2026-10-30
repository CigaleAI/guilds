/** The named errors a generation throws. */

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
