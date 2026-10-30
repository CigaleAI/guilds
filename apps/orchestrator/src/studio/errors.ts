import { ArtifactError } from "../artifacts/errors.js";

export class StudioError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "StudioError";
    this.status = status;
  }
}

export class StudioConflictError extends StudioError {
  constructor(message: string) {
    super(409, message);
    this.name = "StudioConflictError";
  }
}

export class StudioNotFoundError extends StudioError {
  constructor(message: string) {
    super(404, message);
    this.name = "StudioNotFoundError";
  }
}

export class StudioUnprocessableError extends StudioError {
  constructor(message: string) {
    super(422, message);
    this.name = "StudioUnprocessableError";
  }
}

/** An artifacts refusal as Studio reports it, a conflict or a value it cannot use; any other error as it is. */
export function artifactRefusal(error: unknown): unknown {
  if (error instanceof ArtifactError) {
    return error.status === 409 ? new StudioConflictError(error.message) : new StudioUnprocessableError(error.message);
  }
  return error;
}
