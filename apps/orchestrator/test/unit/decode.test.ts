import assert from "node:assert/strict";
import { test } from "node:test";
import { Type } from "typebox";
import { assertMatches } from "../../src/lib/decode.js";

const Item = Type.Object({ id: Type.String(), tags: Type.Optional(Type.Array(Type.String())) });

test("assertMatches passes a payload that matches the schema, extra fields kept", () => {
  const payload: unknown = { id: "a", tags: ["x"], extra: 1 };
  assertMatches(Item, payload, (problem) => new Error(problem));
  assert.deepEqual(payload, { id: "a", tags: ["x"], extra: 1 });
  assert.equal(payload.id, "a");
});

test("assertMatches throws the caller's error naming the first mismatch", () => {
  assert.throws(
    () => assertMatches(Item, { id: "a", tags: [1] }, (problem) => new RangeError(`bad: ${problem}`)),
    (error: unknown) => error instanceof RangeError && /^bad: \/tags\/0: /.test(error.message),
  );
});
