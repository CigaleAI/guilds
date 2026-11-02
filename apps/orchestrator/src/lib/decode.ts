import type { Static, TObject, TSchema } from "typebox";
import { Value } from "typebox/value";
import type { JsonObject } from "./json.js";

/**
 * Asserts that `payload`, a value that arrives untyped, is the type `schema` describes. A payload
 * that does not match throws the error `fail` makes of the first mismatch, named by its JSON pointer.
 */
export function assertMatches<T extends TSchema>(
  schema: T,
  payload: unknown,
  fail: (problem: string) => Error,
): asserts payload is Static<T> {
  if (Value.Check(schema, payload)) {
    return;
  }
  const [first] = Value.Errors(schema, payload);
  throw fail(first ? `${first.instancePath || "/"}: ${first.message}` : "does not match");
}

/**
 * The properties of `value` that match `schema`'s, each one that does not dropped; null when a
 * property the schema requires is missing or does not match.
 */
export function keepMatching<T extends TObject>(schema: T, value: JsonObject): Static<T> | null {
  const kept: JsonObject = {};
  for (const [key, property] of Object.entries(schema.properties)) {
    const field = value[key];
    if (Object.hasOwn(value, key) && Value.Check(property, field)) {
      kept[key] = field;
    }
  }
  return Value.Check(schema, kept) ? kept : null;
}
