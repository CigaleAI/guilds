/** The named errors a native tool throws. The call's result reads `ERROR: ` and the message. */

/** A tool call's arguments the tool refuses: not a JSON object, a field missing, or a value it does not take. */
export class ToolArgumentError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ToolArgumentError";
  }
}

/** A tool this run cannot use: the service, the place, or the kind of run it needs is absent. */
export class ToolUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ToolUnavailableError";
  }
}

/** What a tool sends the sandbox past what the sandbox can take. */
export class ToolLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ToolLimitError";
  }
}

/** A command in the agent's sandbox that was interrupted, failed, or answered in a shape the tool cannot read. */
export class SandboxCommandError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SandboxCommandError";
  }
}
