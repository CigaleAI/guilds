export class McpError extends Error {
  status: number | null;

  constructor(message: string, status: number | null = null) {
    super(message);
    this.name = "McpError";
    this.status = status;
  }
}

/**
 * The server no longer knows the session a request carried: a 404, as the protocol says, or a 400
 * with no JSON-RPC body, as some servers answer. It ran nothing; a new session may retry.
 */
export class McpSessionGoneError extends McpError {
  constructor(status: number) {
    super(`mcp ${status}: the server no longer knows the session`, status);
    this.name = "McpSessionGoneError";
  }
}

export class McpDisconnectedError extends McpError {
  constructor(message: string) {
    super(message);
    this.name = "McpDisconnectedError";
  }
}
