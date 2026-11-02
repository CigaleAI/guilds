import { ArtifactError } from "../artifacts/errors.js";

export class RecipeError extends Error {
  status: number;
  code: string;

  constructor(message: string, status = 422, code = "recipe_invalid") {
    super(message);
    this.name = "RecipeError";
    this.status = status;
    this.code = code;
  }
}

export class RecipeConflictError extends RecipeError {
  body_version?: number;

  constructor(message: string, body_version?: number) {
    super(message, 409, "recipe_conflict");
    this.name = "RecipeConflictError";
    if (body_version !== undefined) {
      this.body_version = body_version;
    }
  }
}

/**
 * An apply whose undo left part of what it made in place: each deletion that failed, with why, and
 * the failure the undo was for, when one was. It answers with that failure's status, else 409.
 */
export class ApplyUndoError extends RecipeError {
  readonly failures: string[];

  constructor(failures: string[], cause?: Error) {
    const undo = `undoing the apply left part of it in place: ${failures.join("; ")}`;
    const status = cause instanceof RecipeError || cause instanceof ArtifactError ? cause.status : 409;
    super(cause ? `${cause.message}; ${undo}` : undo, status, "apply_undo_failed");
    this.name = "ApplyUndoError";
    this.failures = failures;
    if (cause) {
      this.cause = cause;
    }
  }
}
