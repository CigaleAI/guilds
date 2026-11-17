import assert from "node:assert/strict";
import { test } from "node:test";
import type { AccessEntry, AccessSubjectType, AgentAccessMode } from "../../api/types/access";
import type { Collection } from "../../api/types/tables";
import { tablesByAccess, type TableAccessRead } from "./accessGroups";

function table(id: string, name: string, guild: Collection["guild"] = null): Collection {
  return {
    id,
    name,
    purpose: "",
    columns: [],
    display_path: `org/o1/collections/${name}`,
    scope: guild ? "guild" : "org",
    guild,
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    count: 0,
  };
}

function row(
  type: AccessSubjectType,
  id: string,
  name: string,
  mode: AgentAccessMode,
): AccessEntry {
  return { type, id, name, mode, guild_id: type === "org" ? null : "g1", guild_name: null };
}

const read = (subjects: AccessEntry[]): TableAccessRead => ({
  status: "success",
  list: { subjects },
});

/** The groups as label and table names, the shape the list shows. */
function grouped(tables: Collection[], reads: Record<string, TableAccessRead>) {
  return tablesByAccess(tables, (id) => reads[id] ?? { status: "pending" }).map((group) => [
    group.label,
    group.tables.map((item) => item.name),
  ]);
}

test("tables are grouped by the subjects their rows give read or write, never by where they belong", () => {
  const sales = { id: "g_sales", name: "sales" };
  const tables = [
    table("t1", "orders", sales),
    table("t2", "leads"),
    table("t3", "budget", sales),
    table("t4", "roadmap"),
  ];
  assert.deepEqual(
    grouped(tables, {
      t1: read([row("org", "o1", "acme", "read")]),
      t2: read([row("guild", "g_ops", "ops", "write")]),
      t3: read([row("guild", "g_sales", "sales", "read"), row("guild", "g_ops", "ops", "read")]),
      t4: read([row("org", "o1", "acme", "write"), row("guild", "g_ops", "ops", "write")]),
    }),
    [
      ["Organisation", ["orders", "roadmap"]],
      ["Guild · ops", ["budget", "leads", "roadmap"]],
      ["Guild · sales", ["budget"]],
    ],
  );
});

test("guild groups are keyed by id, so two guilds of one name stay apart, ordered by name", () => {
  const groups = tablesByAccess([table("t1", "a"), table("t2", "b")], (id) =>
    read([row("guild", id === "t1" ? "g_2" : "g_1", "twin", "read")]),
  );
  assert.deepEqual(
    groups.map((group) => [group.key, group.label, group.tables.map((item) => item.name)]),
    [
      ["guild:g_1", "Guild · twin", ["b"]],
      ["guild:g_2", "Guild · twin", ["a"]],
    ],
  );
});

test("agents' read and write rows list the table under Individual agents, beside any wider grant", () => {
  assert.deepEqual(
    grouped([table("t1", "notes"), table("t2", "drafts"), table("t3", "shared")], {
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
    grouped([table("t1", "empty"), table("t2", "closed")], {
      t1: read([]),
      t2: read([row("agent", "a1", "scout", "none")]),
    }),
    [["Access not fully known", ["closed", "empty"]]],
  );
});

test("a list with hidden rows left out still shows the grants the viewer sees", () => {
  assert.deepEqual(
    grouped([table("t1", "ledger")], {
      t1: read([row("org", "o1", "acme", "read"), row("agent", "a1", "scout", "none")]),
    }),
    [["Organisation", ["ledger"]]],
  );
});

test("a read still running or failed is its own group, never an empty list", () => {
  assert.deepEqual(
    grouped([table("t1", "slow"), table("t2", "broken"), table("t3", "open")], {
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

test("no tables give no groups", () => {
  assert.deepEqual(grouped([], {}), []);
});
