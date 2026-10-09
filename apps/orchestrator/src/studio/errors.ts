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

export class StudioUnprocessableError extends StudioError {
  constructor(message: string) {
    super(422, message);
    this.name = "StudioUnprocessableError";
  }
}
