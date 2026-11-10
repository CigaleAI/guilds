import assert from "node:assert/strict";
import { test } from "node:test";
import { StudioUnprocessableError } from "../../src/studio/errors.js";
import { parseStudioMode } from "../../src/studio/index.js";

// The mode a create request names: Studio opens sessions in `optimize` only.

test("a_create_request_for_optimize_opens_in_optimize", () => {
  assert.equal(parseStudioMode("optimize"), "optimize");
});

for (const mode of ["create", "rewrite", ""]) {
  test(`a_create_request_for_${mode || "no"}_mode_is_refused`, () => {
    assert.throws(
      () => parseStudioMode(mode),
      (error) => error instanceof StudioUnprocessableError && error.message === "create mode is not available",
    );
  });
}
