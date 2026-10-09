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
