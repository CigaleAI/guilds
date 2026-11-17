import assert from "node:assert/strict";
import { test } from "node:test";
import { diffLineTone, diffstat, headChange } from "./changes";

test("a diffstat names files and line counts", () => {
  assert.equal(diffstat({ files_changed: 3, insertions: 40, deletions: 2 }), "3 files · +40 −2");
  assert.equal(diffstat({ files_changed: 1, insertions: 1, deletions: 0 }), "1 file · +1 −0");
  assert.equal(diffstat({ files_changed: 0, insertions: 0, deletions: 0 }), "no file changes");
});

test("a head change names the branch a turn switched and the head commit it moved", () => {
  const heads = (start_branch: string | null, branch: string | null, start_head_sha: string | null, head_sha: string | null) =>
    headChange({ start_branch, branch, start_head_sha, head_sha });
  assert.equal(heads("main", "main", "1a2b3c4d5e", "5d6e7f8a9b"), "1a2b3c4 → 5d6e7f8");
  assert.equal(heads("main", "topic", "1a2b3c4d5e", "1a2b3c4d5e"), "main → topic");
  assert.equal(heads(null, "main", null, "5d6e7f8a9b"), "no branch → main · none → 5d6e7f8");
  assert.equal(heads("main", "main", "1a2b3c4d5e", "1a2b3c4d5e"), null);
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
