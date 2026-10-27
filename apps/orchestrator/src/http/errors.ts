import { ArtifactError } from "../artifacts/errors.js";
import { AgentError } from "../agents/errors.js";
import { AgentValidationError } from "../agents/validation.js";
import { RunRequestError } from "../generation/index.js";
import { GroupChatError } from "../groupchat/index.js";
import { GuildError } from "../guilds/errors.js";
import { GuildValidationError } from "../guilds/validation.js";
import { IssueError } from "../issues/index.js";
import { ModelNotConnectedError } from "../llm/credentials.js";
import { MachineError } from "../machines/index.js";
import { NotesError } from "../notes/store.js";
import { OrgValidationError } from "../organisations/index.js";
import { OrgError } from "../organisations/service.js";
import { PolicyError } from "../policy/index.js";
import { RecipeConflictError } from "../recipes/errors.js";
import { ScheduleError } from "../schedules/cron.js";
import { ScriptError } from "../scripts/validation.js";
import { UserError } from "../users/directory.js";
import { UserValidationError } from "../users/index.js";

export class HttpError extends Error {
  status: number;
  statusCode: number;
  detail: unknown;

  constructor(status: number, detail: unknown) {
    super(typeof detail === "string" ? detail : JSON.stringify(detail));
    this.name = "HttpError";
    this.status = status;
    this.statusCode = status;
    this.detail = detail;
  }
}

export function missingBodyFields(body: unknown, fields: string[]): HttpError | null {
  const input = body && typeof body === "object" && !Array.isArray(body) ? body : {};
  const missing = fields.filter((field) => !Object.prototype.hasOwnProperty.call(input, field));
  if (!missing.length) {
    return null;
  }
  return new HttpError(
    422,
    missing.map((field) => ({
      type: "missing",
      loc: ["body", field],
      msg: "Field required",
      input,
    })),
  );
}

export function notesWriteHttp(error: Error): HttpError {
  const message = error.message;
  let status = 500;
  if (message.includes("already exists")) {
    status = 409;
  } else if (
    message === "invalid path" ||
    message === "path must end in .md" ||
    message.includes("cannot be") ||
    message === "cannot delete this file"
  ) {
    status = 422;
  } else if (message.includes("not found")) {
    status = 404;
  }
  return new HttpError(status, message);
}

/** Awaits a write that touches the notes folder, answering a refused one as `notesWriteHttp` does. */
export async function notesWrite<T>(write: Promise<T>): Promise<T> {
  try {
    return await write;
  } catch (error) {
    throw error instanceof NotesError ? notesWriteHttp(error) : error;
  }
}

export function artifactHttp(error: ArtifactError): HttpError {
  return new HttpError(error.status, error.message);
}

export function recipeConflictHttp(error: RecipeConflictError): HttpError {
  if (error.body_version !== undefined) {
    return new HttpError(409, { message: error.message, body_version: error.body_version });
  }
  return new HttpError(409, error.message);
}

export function notesReadHttp(error: Error): HttpError {
  const message = error.message;
  return new HttpError(message === "invalid path" ? 422 : 404, message);
}

/** Domain errors that carry the status they answer with. */
const REFUSALS = [
  MachineError,
  PolicyError,
  ModelNotConnectedError,
  UserError,
  OrgError,
  GuildError,
  AgentError,
  ArtifactError,
  RunRequestError,
  GroupChatError,
  ScheduleError,
  ScriptError,
  IssueError,
] as const;

/** Domain errors for a value a validator refused, each a 422. */
const INVALID = [
  UserValidationError,
  OrgValidationError,
  GuildValidationError,
  AgentValidationError,
] as const;

/**
 * The HTTP answer for a refusal a domain module raises: one with its own status, or a value its
 * validator refused. Any other error is null.
 */
export function domainHttp(error: unknown): HttpError | null {
  for (const kind of REFUSALS) {
    if (error instanceof kind) {
      return new HttpError(error.status, error.message);
    }
  }
  for (const kind of INVALID) {
    if (error instanceof kind) {
      return new HttpError(422, error.message);
    }
  }
  return null;
}
