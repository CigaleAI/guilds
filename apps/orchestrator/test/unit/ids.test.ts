import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { ID_ALPHABET, ID_PATTERN, isId, newId } from "../../src/lib/ids.js";
import { repoRoot } from "../../src/lib/paths.js";

const fixture = JSON.parse(
  readFileSync(path.join(repoRoot(import.meta.url), "fixtures/compat/ids/shape.json"), "utf8"),
) as {
  alphabet: string;
  pattern: string;
  samples: string[];
  sample_ok: boolean;
};

test("id shape matches the R0 fixture", () => {
  assert.equal(ID_ALPHABET, fixture.alphabet);
  assert.equal(ID_PATTERN.source, fixture.pattern);
  for (const sample of fixture.samples) {
    assert.equal(ID_PATTERN.test(sample), true);
    assert.equal(isId(sample), true);
  }
  assert.equal(fixture.sample_ok, true);
  const generated = newId("guild");
  assert.equal(isId(generated, "guild"), true);
  assert.match(generated, ID_PATTERN);
});
