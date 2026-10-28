import type { Static, TObject, TSchema } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

/**
 * `payload` as the type `schema` describes. A payload that does not match throws the error `fail`
 * makes of the first mismatch, named by its JSON pointer.
 */
export function decode<T extends TSchema>(schema: T, payload: unknown, fail: (problem: string) => Error): Static<T> {
  if (Value.Check(schema, payload)) {
    return payload;
  }
  const first = Value.Errors(schema, payload).First();
  throw fail(first ? `${first.path || "/"}: ${first.message}` : "does not match");
}

/**
 * The properties of `value` that match `schema`'s, each one that does not dropped; null when a
 * property the schema requires is missing or does not match.
 */
export function keepMatching<T extends TObject>(schema: T, value: Record<string, unknown>): Static<T> | null {
  const kept: Record<string, unknown> = {};
  for (const [key, property] of Object.entries(schema.properties)) {
    if (Object.hasOwn(value, key) && Value.Check(property, value[key])) {
      kept[key] = value[key];
    }
  }
  return Value.Check(schema, kept) ? kept : null;
}
