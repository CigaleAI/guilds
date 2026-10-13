import assert from "node:assert/strict";
import { test } from "node:test";
import { harnessCarried, harnessChoices, harnessLabel, showsHarnessImageNote } from "./harness";

test("a harness the machine's image lacks is unavailable; before the machine starts, none is", () => {
  assert.equal(harnessCarried(["codex"], "codex"), true);
  assert.equal(harnessCarried(["codex"], "cursor"), false);
  assert.equal(harnessCarried(null, "cursor"), null);
  const published = harnessChoices(["codex"]);
  assert.deepEqual(
    published.filter((option) => "disabled" in option).map((option) => option.value),
    ["claude-code", "cursor"],
  );
  assert.ok(harnessChoices(null).every((option) => !("disabled" in option)));
  assert.ok(harnessChoices(undefined).every((option) => !("disabled" in option)));
});

test("the image note shows while the CLIs are unknown or some are missing", () => {
  assert.equal(showsHarnessImageNote(null), true);
  assert.equal(showsHarnessImageNote(["codex"]), true);
  assert.equal(showsHarnessImageNote(["claude-code", "codex", "cursor"]), false);
  assert.equal(harnessLabel("claude-code"), "Claude Code");
});
