/** An agent or run request refused, with the HTTP status it answers with. */
export class AgentError extends Error {
  status: 404 | 409 | 422;

  constructor(status: 404 | 409 | 422, message: string) {
    super(message);
    this.name = "AgentError";
    this.status = status;
  }
}
