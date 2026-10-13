import { ArtifactError } from "../artifacts/errors.js";
import { ModelNotConnectedError } from "../llm/credentials.js";
import { MachineError } from "../machines/index.js";
import { PolicyError } from "../policy/index.js";
import { RecipeConflictError } from "../recipes/errors.js";

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

/**
 * The HTTP answer for a refusal a domain module raises with its own status: a machine request, a
 * policy limit, or a model with no key. Any other error is null.
 */
export function domainHttp(error: unknown): HttpError | null {
  if (error instanceof MachineError || error instanceof PolicyError || error instanceof ModelNotConnectedError) {
    return new HttpError(error.status, error.message);
  }
  return null;
}
