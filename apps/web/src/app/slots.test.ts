import assert from "node:assert/strict";
import { test } from "node:test";
import { chosenTab, placeTabs, type TabSlot } from "./slots";

const core = [
  { value: "general", label: "General" },
  { value: "members", label: "Members" },
  { value: "keys", label: "Model keys" },
];
const slot = (id: string, after?: string): TabSlot => ({
  id,
  label: id,
  ...(after ? { after } : {}),
  render: () => null,
});
const order = (slots: TabSlot[]) => placeTabs(core, slots).map((tab) => tab.value);

test("core's tabs stand alone when no extension adds one", () => {
  assert.deepEqual(placeTabs(core), core);
  assert.deepEqual(order([]), ["general", "members", "keys"]);
});

test("a slot follows the tab it names, and goes last without one", () => {
  assert.deepEqual(order([slot("billing", "members")]), ["general", "members", "billing", "keys"]);
  assert.deepEqual(order([slot("access")]), ["general", "members", "keys", "access"]);
  assert.deepEqual(order([slot("lost", "no-such-tab")]), ["general", "members", "keys", "lost"]);
});

test("slots that follow the same tab keep the order they were given in", () => {
  assert.deepEqual(order([slot("a", "members"), slot("b", "members"), slot("c")]), [
    "general",
    "members",
    "a",
    "b",
    "keys",
    "c",
  ]);
});

test("a page shows the tab asked for when it exists, else its first", () => {
  assert.equal(chosenTab(core, "keys"), "keys");
  assert.equal(chosenTab(core, "billing"), "general");
  assert.equal(chosenTab(core, undefined), "general");
});

test("a page without tabs shows none", () => {
  assert.equal(chosenTab([], "keys"), "");
});
