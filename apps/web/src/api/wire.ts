/** Checks that narrow what the server sends before the app reads it as one of its types. */

/** A JSON object, whose fields can be read by name. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isString(value: unknown): value is string {
  return typeof value === "string";
}

export function isNumber(value: unknown): value is number {
  return typeof value === "number";
}

/** Whether every named field of a record passes `isField`. */
export function hasFields(
  record: Record<string, unknown>,
  fields: readonly string[],
  isField: (value: unknown) => boolean,
): boolean {
  return fields.every((field) => isField(record[field]));
}
