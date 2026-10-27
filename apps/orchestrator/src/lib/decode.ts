import type { Static, TSchema } from "@sinclair/typebox";
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
