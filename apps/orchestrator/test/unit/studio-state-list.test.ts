import assert from "node:assert/strict";
import { test } from "node:test";
import { parseHistoryCursor, parseOperation, parseStateKind } from "../../src/studio/state-data.js";
import {
  changeActor,
  changeEvents,
  changeLink,
  readEvents,
  stateFlags,
  stateRows,
  tablePathOf,
  tallyBy,
  topActor,
  type StateEvent,
  type StateItem,
} from "../../src/studio/state-list.js";
import type { ConfigChangeEventRow, FileChangeEventRow, ReadCallRow } from "../../src/db/state.js";

const agents = new Map([
  ["a_1", "scout"],
  ["a_2", "writer"],
]);

const item = (path: string, overrides: Partial<StateItem> = {}): StateItem => ({
  display_path: path,
  kind: "note",
  level: "guild",
  owner_id: "guild_1",
  title: path.split("/").pop() ?? path,
  size: 10,
  version: 1,
  created_by: "operator",
  created_at: "2026-10-19T10:00:00.000Z",
  collection_id: null,
  note_id: null,
  ...overrides,
});

const at = "2026-10-19T10:00:00.000Z";

const event = (overrides: Partial<StateEvent>): StateEvent => ({
  path: "p",
  at,
  what: "change",
  how: "update",
  actor: { kind: "agent", id: "a_1", name: "scout" },
  link: null,
  record: null,
  ...overrides,
});

/** A file change a person made, as the window query returns it, with `overrides`. */
const fileChange = (overrides: Partial<FileChangeEventRow>): FileChangeEventRow => ({
  display_path: "p",
  operation: "update",
  actor_type: "user",
  actor_id: "u",
  actor_name: "u",
  run_id: null,
  tool_call_id: null,
  studio_session_id: null,
  studio_seq: null,
  created_at: at,
  id: "fc_1",
  run_agent_id: null,
  ...overrides,
});

/** A config change a person made, as the window query returns it, with `overrides`. */
const configChange = (overrides: Partial<ConfigChangeEventRow>): ConfigChangeEventRow => ({
  target_kind: "collection",
  target_id: "col_1",
  operation: "update",
  actor_type: "user",
  actor_id: "u",
  actor_name: "u",
  run_id: null,
  tool_call_id: null,
  studio_session_id: null,
  studio_seq: null,
  created_at: at,
  id: "cc_1",
  summary: "changed",
  run_agent_id: null,
  ...overrides,
});

/** A call of `toolName` with `args`, by agent a_1 in run r_1 unless overridden. */
const readCall = (toolName: string, args: string, overrides: Partial<ReadCallRow> = {}): ReadCallRow => ({
  run_id: "r_1",
  agent_id: "a_1",
  created_at: at,
  tool_name: toolName,
  call_id: null,
  arguments: args,
  ...overrides,
});

test("a change's actor is the run's agent, an agent of another guild without its name, or a person", () => {
  assert.deepEqual(changeActor(fileChange({ run_agent_id: "a_1", actor_type: "run" }), agents), {
    kind: "agent",
    id: "a_1",
    name: "scout",
  });
  assert.deepEqual(changeActor(fileChange({ actor_type: "agent", actor_id: "a_9" }), agents), {
    kind: "other_guild",
    id: "",
    name: "another guild",
  });
  assert.equal(changeActor(fileChange({ actor_type: "run", actor_id: "r_gone" }), agents).kind, "other_guild");
  assert.deepEqual(changeActor(fileChange({ actor_type: "user", actor_id: "u_1", actor_name: "sam" }), agents), {
    kind: "person",
    id: "u_1",
    name: "sam",
  });
});

test("a change links to the coach message it was applied from, else its run step", () => {
  assert.deepEqual(changeLink(fileChange({ studio_session_id: "stu_1", studio_seq: 4, run_id: "r_1" })), {
    kind: "coach",
    session_id: "stu_1",
    seq: 4,
  });
  assert.deepEqual(changeLink(fileChange({ run_id: "r_1", run_agent_id: "a_1", tool_call_id: "c_1" })), {
    kind: "run",
    run_id: "r_1",
    agent_id: "a_1",
    call_id: "c_1",
  });
  assert.equal(changeLink(fileChange({ studio_session_id: "stu_1", studio_seq: null })), null);
});

test("a record's path names its table", () => {
  assert.equal(tablePathOf("org/o/collections/leads/4"), "org/o/collections/leads");
  assert.equal(tablePathOf("org/o/collections/leads"), null);
  assert.equal(tablePathOf("org/o/guilds/g/rules.md"), null);
});

test("changes land on their item, records on their table, and config changes on the table or note by id", () => {
  const items = [
    item("org/o/guilds/g/rules.md", { note_id: "art_1" }),
    item("org/o/collections/leads", { kind: "table", collection_id: "col_1" }),
  ];
  const events = changeEvents(
    [
      fileChange({ display_path: "org/o/guilds/g/rules.md" }),
      fileChange({ display_path: "org/o/collections/leads/3", operation: "delete", actor_type: "run", run_agent_id: "a_2" }),
      fileChange({ display_path: "org/o/guilds/g/other.md" }),
    ],
    [
      configChange({ target_kind: "collection", target_id: "col_1" }),
      configChange({ target_kind: "collection", target_id: "col_gone", operation: "delete" }),
      configChange({ target_kind: "note", target_id: "art_1", operation: "create" }),
      configChange({ target_kind: "note", target_id: "col_1", operation: "delete" }),
    ],
    { items, agents },
  );
  assert.deepEqual(
    events.map((entry) => [entry.path, entry.how, entry.record]),
    [
      ["org/o/guilds/g/rules.md", "update", null],
      ["org/o/collections/leads", "delete", "org/o/collections/leads/3"],
      ["org/o/collections/leads", "update", null],
      ["org/o/guilds/g/rules.md", "create", null],
    ],
  );
});

test("reads come from what a run inlined, its Memory, and the tool calls that name an item", () => {
  const items = [
    item("org/o/guilds/g/rules.md"),
    item("org/o/collections/leads", { kind: "table", title: "leads" }),
    item("org/o/agents/a_1/memory.md", { kind: "memory", owner_id: "a_1" }),
    item("org/o/agents/a_1/scripts/tally", { kind: "script", owner_id: "a_1", title: "tally" }),
  ];
  const run = { id: "r_1", run_id: "r_1", agent_id: "a_1", created_at: at };
  const embed = (displayPath: string) => ({ display_path: displayPath, version: 1, content_hash: "h", kind: "note" });
  const events = readEvents(
    [
      {
        ...run,
        task_source: {
          version: 1,
          hash: "t",
          display_path: "org/o/agents/a_1/task.md",
          embeds: [embed("org/o/guilds/g/rules.md"), embed("org/o/guilds/g/gone.md")],
          collections: ["org/o/collections/leads"],
          has_embeds: true,
        },
      },
      { id: "r_2", run_id: "r_2", agent_id: "a_2", created_at: at, task_source: null },
    ],
    [
      readCall("note_get", '{"path":"org/o/guilds/g/rules.md"}'),
      readCall("record_search", '{"collection":"leads"}'),
      readCall("script_run", '{"name":"tally"}'),
      readCall("tally", "not json"),
      readCall("note_get", '["not", "an object"]'),
      readCall("tally", "{}", { run_id: "r_2", agent_id: "a_2" }),
    ],
    { items, agents },
  );
  assert.deepEqual(
    events.map((entry) => `${entry.path.split("/").pop()}:${entry.how}`),
    ["rules.md:embed", "leads:embed", "memory.md:memory", "rules.md:note_get", "leads:record_search", "tally:script", "tally:script"],
  );
});

test("an item is flagged when no agent reads it, it has many writers, an agent deletes another's rows, or nothing touched it", () => {
  const table = item("t", { kind: "table" });
  assert.deepEqual(stateFlags(item("n"), [], []), ["no_agent_read", "untouched"]);
  const many = ["a", "b", "c"].map((id) => event({ actor: { kind: "person", id, name: id } }));
  assert.deepEqual(stateFlags(item("n"), many, [event({ what: "read" })]), ["writers"]);
  const created = event({ how: "create", record: "t/1", actor: { kind: "agent", id: "a_1", name: "scout" } });
  const deleted = event({ how: "delete", record: "t/1", actor: { kind: "agent", id: "a_2", name: "writer" } });
  assert.ok(stateFlags(table, [created, deleted], []).includes("deletes_others_rows"));
  const ownDelete = event({ how: "delete", record: "t/1", actor: { kind: "agent", id: "a_1", name: "scout" } });
  assert.equal(stateFlags(table, [created, ownDelete], []).includes("deletes_others_rows"), false);
  assert.equal(stateFlags(table, [deleted], []).includes("deletes_others_rows"), false);
});

test("rows count people and this guild's agents, and narrow by kind and agent", () => {
  const items = [item("n1", { owner_id: "a_2" }), item("n2"), item("t", { kind: "table" })];
  const events = [
    event({ path: "n2" }),
    event({ path: "n2", actor: { kind: "other_guild", id: "", name: "another guild" } }),
    event({ path: "n2", what: "read", how: "embed" }),
  ];
  const rows = stateRows(items, events, { kind: null, agentId: null });
  const n2 = rows.find((row) => row.display_path === "n2");
  assert.equal(n2?.changes, 1);
  assert.equal(n2?.reads, 1);
  assert.equal(n2?.last_change?.actor.name, "scout");
  assert.equal(rows.find((row) => row.display_path === "n1")?.last_change, null);
  assert.deepEqual(
    stateRows(items, events, { kind: "table", agentId: null }).map((row) => row.display_path),
    ["t"],
  );
  assert.deepEqual(
    stateRows(items, events, { kind: null, agentId: "a_1" }).map((row) => row.display_path),
    ["n2"],
  );
  assert.deepEqual(
    stateRows(items, events, { kind: null, agentId: "a_2" }).map((row) => row.display_path),
    ["n1"],
  );
});

test("the top actor carries its share, and tallies group by actor and how", () => {
  assert.equal(topActor([]), null);
  const two = [event({}), event({}), event({ actor: { kind: "person", id: "u", name: "sam" } })];
  assert.deepEqual(topActor(two)?.actor.name, "scout");
  assert.equal(topActor(two)?.share, 2 / 3);
  assert.deepEqual(
    tallyBy([...two, event({ how: "delete" })]).map((entry) => `${entry.actor.name}:${entry.how}:${entry.count}`),
    ["scout:update:2", "sam:update:1", "scout:delete:1"],
  );
});

test("query values are checked: kind, operation, and a page cursor", () => {
  assert.equal(parseStateKind(undefined), null);
  assert.equal(parseStateKind("table"), "table");
  assert.throws(() => parseStateKind("routine"), /kind must be/);
  assert.equal(parseOperation(""), null);
  assert.equal(parseOperation("delete"), "delete");
  assert.throws(() => parseOperation("rename"), /op must be/);
  assert.equal(parseHistoryCursor(null), null);
  assert.deepEqual(parseHistoryCursor("2026-10-19T10:00:00.000Z~fc_1"), { at: "2026-10-19T10:00:00.000Z", id: "fc_1" });
  assert.throws(() => parseHistoryCursor("oops"), /cursor/);
  assert.throws(() => parseHistoryCursor("yesterday~fc_1"), /cursor/);
});
