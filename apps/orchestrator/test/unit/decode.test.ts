import assert from "node:assert/strict";
import { test } from "node:test";
import { Type } from "@sinclair/typebox";
import { decode } from "../../src/lib/decode.js";

const Item = Type.Object({ id: Type.String(), tags: Type.Optional(Type.Array(Type.String())) });

test("decode returns a payload that matches the schema, extra fields kept", () => {
  const payload = { id: "a", tags: ["x"], extra: 1 };
  assert.deepEqual(decode(Item, payload, (problem) => new Error(problem)), payload);
});

test("decode throws the caller's error naming the first mismatch", () => {
  assert.throws(
    () => decode(Item, { id: "a", tags: [1] }, (problem) => new RangeError(`bad: ${problem}`)),
    (error: unknown) => error instanceof RangeError && /^bad: \/tags\/0: /.test(error.message),
  );
});
