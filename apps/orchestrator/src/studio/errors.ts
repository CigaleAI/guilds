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

export function artifactFailure(error: unknown): never {
  if (error instanceof ArtifactError) {
    throw error.status === 409 ? new StudioConflictError(error.message) : new StudioUnprocessableError(error.message);
  }
  throw error;
}
