export class ConversationError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "ConversationError";
    this.status = status;
  }
}

export class ConversationConflictError extends ConversationError {
  constructor(message: string) {
    super(409, message);
    this.name = "ConversationConflictError";
  }
}
