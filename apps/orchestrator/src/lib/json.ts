/** A value JSON carries: a string, number, boolean or null, or an array or object of them. */
export type JsonValue = string | number | boolean | null | JsonValue[] | JsonObject;

/** A JSON object. A field held as `undefined` is one JSON leaves out. */
export type JsonObject = { [key: string]: JsonValue | undefined };

/** Whether a value is one JSON carries, every element and field of it included. */
export function isJsonValue(value: unknown): value is JsonValue {
  if (value === null) return true;
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return true;
  if (Array.isArray(value)) return value.every(isJsonValue);
  return isJsonObject(value);
}

/** Whether a value is a JSON object: a plain object, every field of it a JSON value or left out. */
export function isJsonObject(value: unknown): value is JsonObject {
  if (typeof value !== "object" || value === null) return false;
  const prototype: unknown = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  return Object.values(value).every((field) => field === undefined || isJsonValue(field));
}

/** Whether a JSON value is an object, and not an array or a scalar. */
function isObjectNode(value: JsonValue): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The value with every object's keys in sorted order, at every depth. */
export function sortKeys(value: JsonValue): JsonValue {
  if (Array.isArray(value)) {
    return value.map((item) => sortKeys(item));
  }
  if (!isObjectNode(value)) {
    return value;
  }
  const out: JsonObject = {};
  for (const key of Object.keys(value).sort()) {
    const field = value[key];
    out[key] = field === undefined ? undefined : sortKeys(field);
  }
  return out;
}

/** The value as JSON text with sorted keys and no whitespace; `ensureAscii` escapes every non-ASCII character. */
export function dumpsCompact(value: JsonValue, ensureAscii = false): string {
  const json = JSON.stringify(sortKeys(value));
  if (!ensureAscii) {
    return json;
  }
  return json.replace(/[\u007f-\uffff]/g, (char) => {
    return `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`;
  });
}
