import assert from "node:assert/strict";
import { test } from "node:test";
import { diffLineTone, diffstat } from "./changes";

test("a diffstat names files and line counts", () => {
  assert.equal(diffstat({ files_changed: 3, insertions: 40, deletions: 2 }), "3 files · +40 −2");
  assert.equal(diffstat({ files_changed: 1, insertions: 1, deletions: 0 }), "1 file · +1 −0");
  assert.equal(diffstat({ files_changed: 0, insertions: 0, deletions: 0 }), "no changes");
});

test("diff lines are told apart", () => {
  assert.equal(diffLineTone("diff --git a/x b/x"), "meta");
  assert.equal(diffLineTone("--- a/x"), "meta");
  assert.equal(diffLineTone("+++ b/x"), "meta");
  assert.equal(diffLineTone("@@ -1,2 +1,3 @@"), "hunk");
  assert.equal(diffLineTone("+added"), "added");
  assert.equal(diffLineTone("-removed"), "removed");
  assert.equal(diffLineTone(" same"), "context");
});
