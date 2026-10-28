/** A guild request refused, with the HTTP status it answers with. */
export class GuildError extends Error {
  status: 403 | 404 | 409 | 422 | 503;

  constructor(status: 403 | 404 | 409 | 422 | 503, message: string) {
    super(message);
    this.name = "GuildError";
    this.status = status;
  }
}

/** Adding agents to a guild past its agent limit, refused with 409. */
export class GuildAgentLimitError extends Error {
  readonly status = 409;
  readonly limit: number;

  constructor(limit: number) {
    super(`this guild is limited to ${limit} agents`);
    this.name = "GuildAgentLimitError";
    this.limit = limit;
  }
}
