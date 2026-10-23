import assert from "node:assert/strict";
import { test } from "node:test";
import { linkMarkup, remarkEmbeds } from "./embeds";
import type { MdNode } from "./textNodes";

function paragraph(value: string): MdNode {
  return { type: "root", children: [{ type: "paragraph", children: [{ type: "text", value }] }] };
}

test("link_markup_embeds_or_references_a_path", () => {
  assert.equal(linkMarkup("org/o/guilds/g/rules.md", "embed"), "![[org/o/guilds/g/rules.md]]");
  assert.equal(linkMarkup("org/o/guilds/g/rules.md", "reference"), "[[org/o/guilds/g/rules.md]]");
});

test("embeds_and_references_become_separate_chips", () => {
  const tree = paragraph("Follow ![[org/o/a.md]] and read [[org/o/b.md]] when needed.");
  remarkEmbeds()(tree);
  const nodes = tree.children?.[0]?.children ?? [];
  assert.deepEqual(
    nodes.map((node) => node.type),
    ["text", "embed", "text", "reference", "text"],
  );
  assert.deepEqual(nodes[1]?.data?.hProperties, { dataEmbed: "org/o/a.md" });
  assert.deepEqual(nodes[3]?.data?.hProperties, { dataReference: "org/o/b.md" });
});

test("an_embed_is_not_also_read_as_a_reference", () => {
  const tree = paragraph("![[org/o/a.md]]");
  remarkEmbeds()(tree);
  assert.deepEqual(
    tree.children?.[0]?.children?.map((node) => node.type),
    ["embed"],
  );
});
