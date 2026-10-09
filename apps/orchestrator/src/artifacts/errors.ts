export class ArtifactError extends Error {
  status: number;

  constructor(message: string, status = 422) {
    super(message);
    this.name = "ArtifactError";
    this.status = status;
  }
}
