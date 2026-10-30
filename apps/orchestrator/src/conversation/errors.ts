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

/** The operator cancelled the generation while the model was answering. */
export class ConversationCancelled extends Error {
  constructor() {
    super("cancelled");
    this.name = "ConversationCancelled";
  }
}
