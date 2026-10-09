import assert from "node:assert/strict";
import { test } from "node:test";
import { promptBlocks, promptText } from "./promptBlocks";

test("tagged parts nest, and the text between them stays", () => {
  const blocks = promptBlocks(
    'Intro line.\n<group>\n<members>a, b</members>\nTail</group>\n<note path="org/o/guilds/g/notes/plan.md">Plan body</note>',
  );
  assert.equal(blocks.length, 3);
  assert.deepEqual(blocks[0], { type: "text", text: "Intro line." });
  const group = blocks[1];
  assert.ok(group?.type === "tag");
  assert.equal(group.tag, "group");
  assert.deepEqual(group.children, [
    { type: "tag", tag: "members", path: null, content: "a, b", children: null },
    { type: "text", text: "Tail" },
  ]);
  const note = blocks[2];
  assert.ok(note?.type === "tag");
  assert.equal(note.path, "org/o/guilds/g/notes/plan.md");
  assert.equal(note.children, null);
});

test("JSON reads as a value, with any words before it", () => {
  assert.deepEqual(promptText('{"a": 1}'), { kind: "json", value: { a: 1 }, lead: "" });
  assert.deepEqual(promptText('State: {"guild": "g"}'), {
    kind: "json",
    value: { guild: "g" },
    lead: "State:",
  });
  assert.deepEqual(promptText("Just words {not json"), {
    kind: "markdown",
    text: "Just words {not json",
  });
});
