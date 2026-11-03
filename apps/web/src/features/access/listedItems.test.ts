import assert from "node:assert/strict";
import { test } from "node:test";
import type { ItemSections, ListedItem, ViewerMode } from "../../api/types/access";
import {
  filterSections,
  findOpenItem,
  homeLabel,
  isUnreached,
  itemBrowserKey,
  listedItems,
  type OpenItem,
} from "./listedItems";

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

const openPath = (opened: OpenItem<ListedItem>) =>
  opened.state === "open" ? opened.item.display_path : opened.state;

test("without a choice, the first reached item opens and an unreached one never does", () => {
  assert.equal(openPath(findOpenItem(sections, undefined)), "org/o/plan.md");
  const onlyShared = { own: [item("draft.md", "none")], shared: [item("brand.md", "read")] };
  assert.equal(openPath(findOpenItem(onlyShared, undefined)), "org/o/brand.md");
  const noneReached = { own: [item("draft.md", "none")], shared: [] };
  assert.deepEqual(findOpenItem(noneReached, undefined), { state: "none" });
  assert.deepEqual(findOpenItem({ own: [], shared: [] }, undefined), { state: "none" });
});

test("the chosen item opens from either section, reached or not", () => {
  assert.equal(openPath(findOpenItem(sections, "org/o/brand.md")), "org/o/brand.md");
  assert.equal(openPath(findOpenItem(sections, "org/o/legal.md")), "org/o/legal.md");
  assert.equal(openPath(findOpenItem(sections, "org/o/draft.md")), "org/o/draft.md");
});

test("a chosen path the page does not list opens no other item", () => {
  assert.deepEqual(findOpenItem(sections, "org/o/gone.md"), {
    state: "unlisted",
    path: "org/o/gone.md",
  });
});

test("a browser's key changes with the page's guild or agent and with the path opened first", () => {
  const guildA = itemBrowserKey({ type: "guild", id: "a" }, "org/o/plan.md");
  assert.equal(guildA, itemBrowserKey({ type: "guild", id: "a" }, "org/o/plan.md"));
  assert.notEqual(guildA, itemBrowserKey({ type: "guild", id: "b" }, "org/o/plan.md"));
  assert.notEqual(guildA, itemBrowserKey({ type: "agent", id: "a" }, "org/o/plan.md"));
  assert.notEqual(guildA, itemBrowserKey({ type: "guild", id: "a" }, "org/o/brand.md"));
  assert.notEqual(guildA, itemBrowserKey({ type: "guild", id: "a" }, undefined));
});
