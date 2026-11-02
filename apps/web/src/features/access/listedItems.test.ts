import assert from "node:assert/strict";
import { test } from "node:test";
import type { ItemSections, ListedItem } from "../../api/types/access";
import type { ViewerMode } from "@guildsrun/ui";
import { filterSections, findOpenItem, homeLabel, isUnreached, listedItems } from "./listedItems";

function item(name: string, viewer_mode: ViewerMode): ListedItem {
  return { display_path: `org/o/${name}`, home: { id: "g1", name: "Research" }, viewer_mode };
}

const sections: ItemSections<ListedItem> = {
  own: [item("draft.md", "none"), item("plan.md", "all_write")],
  shared: [item("brand.md", "read"), item("legal.md", "none")],
};

const paths = (items: readonly ListedItem[]) => items.map((listed) => listed.display_path);

test("an item no row reaches for the page is unreached, any other mode reaches it", () => {
  assert.equal(isUnreached(item("a.md", "none")), true);
  for (const mode of ["write", "read", "all_write", "all_read", "some"] as const) {
    assert.equal(isUnreached(item("a.md", mode)), false);
  }
});

test("an item's home is named by its guild, or as the organisation's without one", () => {
  assert.equal(homeLabel(item("a.md", "read")), "Research");
  assert.equal(homeLabel({ ...item("a.md", "read"), home: null }), "Organisation");
});

test("the listed items are the guild's own, then those shared with it", () => {
  assert.deepEqual(paths(listedItems(sections)), [
    "org/o/draft.md",
    "org/o/plan.md",
    "org/o/brand.md",
    "org/o/legal.md",
  ]);
});

test("a filter keeps the matching items of each section", () => {
  const kept = filterSections(sections, (listed) => listed.display_path.includes("l"));
  assert.deepEqual(paths(kept.own), ["org/o/plan.md"]);
  assert.deepEqual(paths(kept.shared), ["org/o/legal.md"]);
});

test("without a choice, the first reached item opens and an unreached one never does", () => {
  assert.equal(findOpenItem(sections, undefined)?.display_path, "org/o/plan.md");
  const onlyShared = { own: [item("draft.md", "none")], shared: [item("brand.md", "read")] };
  assert.equal(findOpenItem(onlyShared, undefined)?.display_path, "org/o/brand.md");
  const noneReached = { own: [item("draft.md", "none")], shared: [] };
  assert.equal(findOpenItem(noneReached, undefined), undefined);
  assert.equal(findOpenItem({ own: [], shared: [] }, undefined), undefined);
});

test("the chosen item opens from either section, and a choice no longer listed falls back", () => {
  assert.equal(findOpenItem(sections, "org/o/brand.md")?.display_path, "org/o/brand.md");
  assert.equal(findOpenItem(sections, "org/o/legal.md")?.display_path, "org/o/legal.md");
  assert.equal(findOpenItem(sections, "org/o/gone.md")?.display_path, "org/o/plan.md");
});
