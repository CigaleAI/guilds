import assert from "node:assert/strict";
import { test } from "node:test";
import { isHandle, remarkMentions } from "./mentions";
import type { MdNode } from "./textNodes";

test("handles are lowercase names the orchestrator can tag", () => {
  assert.ok(isHandle("managooor"));
  assert.ok(isHandle("x-access"));
  assert.ok(!isHandle("Emma Martin"));
  assert.ok(!isHandle("9lives"));
});

test("only tagged handles become mention nodes", () => {
  const tree: MdNode = {
    type: "root",
    children: [{ type: "paragraph", children: [{ type: "text", value: "@wallet ask @nobody, mail a@b.co" }] }],
  };
  remarkMentions({ names: ["wallet"] })(tree);
  const paragraph = tree.children?.[0];
  assert.deepEqual(
    paragraph?.children?.map((node) => node.type),
    ["mention", "text"],
  );
  assert.equal(paragraph?.children?.[1]?.value, " ask @nobody, mail a@b.co");
});
