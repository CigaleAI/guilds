import assert from "node:assert/strict";
import { test } from "node:test";
import type { AccessEntry, AccessSubjectType, AgentAccessMode } from "../../api/types/access";
import { itemsByAccess, type AccessRead } from "./accessGroups";

type Item = { id: string; name: string };

const item = (id: string, name: string): Item => ({ id, name });

function row(
  type: AccessSubjectType,
  id: string,
  name: string,
  mode: AgentAccessMode,
): AccessEntry {
  return { type, id, name, mode, guild_id: type === "org" ? null : "g1", guild_name: null };
}

const read = (subjects: AccessEntry[]): AccessRead => ({
  status: "success",
  list: { subjects },
});

/** The groups as label and item names, the shape the list shows. */
function grouped(items: Item[], reads: Record<string, AccessRead>) {
  return itemsByAccess(items, (entry) => reads[entry.id] ?? { status: "pending" }).map((group) => [
    group.label,
    group.items.map((entry) => entry.name),
  ]);
}

test("items are grouped by the subjects their rows give read or write, each group in the items' order", () => {
  assert.deepEqual(
    grouped(
      [item("t3", "budget"), item("t2", "leads"), item("t1", "orders"), item("t4", "roadmap")],
      {
        t1: read([row("org", "o1", "acme", "read")]),
        t2: read([row("guild", "g_ops", "ops", "write")]),
        t3: read([row("guild", "g_sales", "sales", "read"), row("guild", "g_ops", "ops", "read")]),
        t4: read([row("org", "o1", "acme", "write"), row("guild", "g_ops", "ops", "write")]),
      },
    ),
    [
      ["Organisation", ["orders", "roadmap"]],
      ["Guild · ops", ["budget", "leads", "roadmap"]],
      ["Guild · sales", ["budget"]],
    ],
  );
});

test("guild groups are keyed by id, so two guilds of one name stay apart, ordered by name", () => {
  const groups = itemsByAccess([item("t1", "a"), item("t2", "b")], (entry) =>
    read([row("guild", entry.id === "t1" ? "g_2" : "g_1", "twin", "read")]),
  );
  assert.deepEqual(
    groups.map((group) => [group.key, group.label, group.items.map((entry) => entry.name)]),
    [
      ["guild:g_1", "Guild · twin", ["b"]],
      ["guild:g_2", "Guild · twin", ["a"]],
    ],
  );
});

test("agents' read and write rows list the item under Individual agents, beside any wider grant", () => {
  assert.deepEqual(
    grouped([item("t2", "drafts"), item("t1", "notes"), item("t3", "shared")], {
      t1: read([row("agent", "a1", "scout", "read")]),
      t2: read([row("agent", "a1", "scout", "write"), row("agent", "a2", "keeper", "none")]),
      t3: read([row("org", "o1", "acme", "read"), row("agent", "a1", "scout", "write")]),
    }),
    [
      ["Organisation", ["shared"]],
      ["Individual agents", ["drafts", "notes", "shared"]],
    ],
  );
});

test("an empty list and a list of only None rows are not fully known, never an empty group", () => {
  assert.deepEqual(
    grouped([item("t2", "closed"), item("t1", "empty")], {
      t1: read([]),
      t2: read([row("agent", "a1", "scout", "none")]),
    }),
    [["Access not fully known", ["closed", "empty"]]],
  );
});

test("a list with hidden rows left out still shows the grants the viewer sees", () => {
  assert.deepEqual(
    grouped([item("t1", "ledger")], {
      t1: read([row("org", "o1", "acme", "read"), row("agent", "a1", "scout", "none")]),
    }),
    [["Organisation", ["ledger"]]],
  );
});

test("a read still running or failed is its own group, never an empty list", () => {
  assert.deepEqual(
    grouped([item("t1", "slow"), item("t2", "broken"), item("t3", "open")], {
      t2: { status: "error" },
      t3: read([row("org", "o1", "acme", "read")]),
    }),
    [
      ["Organisation", ["open"]],
      ["Reading access", ["slow"]],
      ["Couldn't read access", ["broken"]],
    ],
  );
});

test("no items give no groups", () => {
  assert.deepEqual(grouped([], {}), []);
});
