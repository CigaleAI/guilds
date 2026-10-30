import type { FastifySchemaValidationError } from "fastify";
import { ArtifactError } from "../artifacts/errors.js";
import { AttachmentError } from "../attachments/index.js";
import { RepositoryValidationError } from "../coding/repositories.js";
import { ConnectError } from "../mcp/connect-token.js";
import { SettingsError } from "../connectors/settings.js";
import { CredentialError } from "../credentials/validate.js";
import { AgentError } from "../agents/errors.js";
import { BuilderError } from "../builder/errors.js";
import { AgentValidationError } from "../agents/validation.js";
import { BindingError } from "../access/index.js";
import { RunRequestError } from "../generation/index.js";
import { GroupChatError } from "../groupchat/index.js";
import { GuildAgentLimitError, GuildError } from "../guilds/errors.js";
import { GuildValidationError } from "../guilds/validation.js";
import { IssueError } from "../issues/index.js";
import { ModelNotConnectedError } from "../llm/credentials.js";
import { ModelsError } from "../llm/models.js";
import { InstanceKeyError } from "../instance/keys.js";
import { MachineError } from "../machines/index.js";
import { CatalogError } from "../mcp/catalog.js";
import { OperatorCallError } from "../mcp/operator-call.js";
import { ConnectionError } from "../mcp/visibility.js";
import { NotesError } from "../notes/errors.js";
import { OrgValidationError } from "../organisations/index.js";
import { OrgError } from "../organisations/service.js";
import { PolicyError } from "../policy/index.js";
import { RecipeConflictError, RecipeError } from "../recipes/errors.js";
import { RegistryError } from "../registry/index.js";
import { ScheduleError } from "../schedules/cron.js";
import { ScriptError } from "../scripts/validation.js";
import { SecretAccessError } from "../secrets/access.js";
import { SecretError } from "../secrets/service.js";
import { StudioError } from "../studio/errors.js";
import { UserError } from "../users/directory.js";
import { UserValidationError } from "../users/index.js";
import { SandboxProxyError } from "./sandbox-proxy.js";

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

/** One problem a route's schema found in a request: its kind, where it sits, and the value there. */
export type ValidationProblem = {
  type: string;
  loc: string[];
  msg: string;
  input: unknown;
};

/**
 * The 422 for a request its route's schema refused. A missing field is `missing` at the field's
 * path, with the object it is missing from as its input; any other problem is the schema keyword
 * it broke, at the value's path. `part` is the part of the request refused: `body`, `querystring`,
 * `params` or `headers`.
 */
export function validationHttp(errors: FastifySchemaValidationError[], part: string): HttpError {
  return new HttpError(
    422,
    errors.map((error): ValidationProblem => {
      const path = error.instancePath
        .split("/")
        .slice(1)
        .map((segment) => segment.replaceAll("~1", "/").replaceAll("~0", "~"));
      const input = "data" in error ? error.data : undefined;
      const missing = error.params.missingProperty;
      if (error.keyword === "required" && typeof missing === "string") {
        return { type: "missing", loc: [part, ...path, missing], msg: "Field required", input };
      }
      return {
        type: error.keyword,
        loc: [part, ...path],
        msg: error.message ?? "is invalid",
        input,
      };
    }),
  );
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

/** Awaits a read of the notes folder, answering a refused one as `notesReadHttp` does. */
export async function notesRead<T>(read: Promise<T>): Promise<T> {
  try {
    return await read;
  } catch (error) {
    throw error instanceof NotesError ? notesReadHttp(error) : error;
  }
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
  GuildAgentLimitError,
  AgentError,
  ArtifactError,
  RunRequestError,
  GroupChatError,
  ScheduleError,
  ScriptError,
  IssueError,
  AttachmentError,
  SecretError,
  BindingError,
  ConnectionError,
  ConnectError,
  OperatorCallError,
  CatalogError,
  InstanceKeyError,
  RepositoryValidationError,
  StudioError,
  BuilderError,
  RecipeError,
  ModelsError,
  RegistryError,
  SandboxProxyError,
] as const;

/** Domain errors for a value a validator refused, each a 422. */
const INVALID = [
  UserValidationError,
  OrgValidationError,
  GuildValidationError,
  AgentValidationError,
  CredentialError,
  SecretAccessError,
  SettingsError,
] as const;

/**
 * The HTTP answer for a refusal a domain module raises: a recipe conflict with the version it met,
 * one with its own status, answered with its detail when it carries one, or a value its validator
 * refused. Any other error is null.
 */
export function domainHttp(error: unknown): HttpError | null {
  if (error instanceof RecipeConflictError) {
    return recipeConflictHttp(error);
  }
  for (const kind of REFUSALS) {
    if (error instanceof kind) {
      const detail = "detail" in error && error.detail !== undefined ? error.detail : error.message;
      return new HttpError(error.status, detail);
    }
  }
  for (const kind of INVALID) {
    if (error instanceof kind) {
      return new HttpError(422, error.message);
    }
  }
  return null;
}
