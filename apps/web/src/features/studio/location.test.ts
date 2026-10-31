import assert from "node:assert/strict";
import { test } from "node:test";
import { agentTab, focusLocation, parseStudioSearch, revealedStep, tablePathOf } from "./location";

test("a run or issue pin opens the agent's History at the step", () => {
  assert.deepEqual(
    focusLocation({
      kind: "run",
      label: "",
      agent_id: "a_1",
      run_id: "r_1",
      call_id: "c_1",
      seq: 4,
    }),
    { section: "agents", agent: "a_1", tab: "history", item: "r_1", call: "c_1", seq: 4 },
  );
  assert.deepEqual(focusLocation({ kind: "issue", label: "", agent_id: "a_1", run_id: "r_1" }), {
    section: "agents",
    agent: "a_1",
    tab: "history",
    item: "r_1",
  });
  assert.equal(focusLocation({ kind: "issue", label: "" }), null);
});

test("a memory or routine pin opens its agent's tab", () => {
  assert.deepEqual(
    focusLocation({ kind: "memory_version", label: "", agent_id: "a_1", revision_id: null }),
    { section: "agents", agent: "a_1", tab: "memory", item: "live" },
  );
  assert.equal(focusLocation({ kind: "memory_version", label: "" }), null);
  assert.deepEqual(
    focusLocation({ kind: "routine", label: "", agent_id: "a_1", schedule_id: "s_1" }),
    { section: "agents", agent: "a_1", tab: "routines", item: "s_1" },
  );
  assert.equal(focusLocation({ kind: "routine", label: "", agent_id: "a_1" }), null);
});

test("a file pin opens State with the file selected, and a record its table", () => {
  assert.deepEqual(
    focusLocation({
      kind: "file",
      label: "",
      agent_id: "a_1",
      display_path: "org/o/agents/a_1/scripts/calc_valuation",
    }),
    {
      section: "state",
      agent: "a_1",
      tab: "list",
      item: "org/o/agents/a_1/scripts/calc_valuation",
    },
  );
  assert.deepEqual(
    focusLocation({ kind: "file", label: "", display_path: "org/o/collections/c/12" }),
    { section: "state", tab: "list", item: "org/o/collections/c" },
  );
  assert.deepEqual(focusLocation({ kind: "file", label: "" }), { section: "state", tab: "list" });
});

test("a table's path is its own, and a record's names its table", () => {
  assert.equal(tablePathOf("org/o/collections/c"), "org/o/collections/c");
  assert.equal(tablePathOf("org/o/collections/c/12"), "org/o/collections/c");
  assert.equal(tablePathOf("org/o/guilds/g/a.md"), null);
});

test("a pin of an unknown kind points nowhere", () => {
  assert.equal(focusLocation({ kind: "focus", label: "" }), null);
});

test("a URL without a known section opens the guild overview", () => {
  assert.deepEqual(parseStudioSearch({}), { section: "guild" });
  assert.deepEqual(parseStudioSearch({ agent: "a_1", tab: "memory" }), { section: "guild" });
  assert.deepEqual(parseStudioSearch({ section: "files", agent: "a_1" }), { section: "guild" });
});

test("the agents section keeps an agent's tab and step, and the topology selection", () => {
  assert.deepEqual(
    parseStudioSearch({ section: "agents", agent: "a_1", tab: "memory", seq: "3", call: "c" }),
    { section: "agents", agent: "a_1", tab: "memory", call: "c", seq: 3 },
  );
  assert.deepEqual(parseStudioSearch({ section: "agents", agent: "a_1", tab: "list", seq: "-1" }), {
    section: "agents",
    agent: "a_1",
  });
  assert.deepEqual(
    parseStudioSearch({ section: "agents", tab: "memory", item: "link:operator>a_1", seq: "2" }),
    { section: "agents", item: "link:operator>a_1" },
  );
});

test("State keeps its view, agent filter, kind and selection", () => {
  assert.deepEqual(
    parseStudioSearch({
      section: "state",
      agent: "a_1",
      tab: "references",
      kind: "table",
      item: "t_1",
      seq: "2",
    }),
    { section: "state", agent: "a_1", tab: "references", kind: "table", item: "t_1" },
  );
  assert.deepEqual(parseStudioSearch({ section: "state", tab: "memory", kind: "runs" }), {
    section: "state",
  });
});

test("Tools keeps only the selected tool", () => {
  assert.deepEqual(parseStudioSearch({ section: "tools", item: "note_get", agent: "a_1" }), {
    section: "tools",
    item: "note_get",
  });
});

test("an agent opens on the tab asked for, else where a request waits, else Prompt", () => {
  const tabs = ["prompt", "draft", "memory", "routines"] as const;
  assert.equal(agentTab("routines", ["memory"], tabs), "routines");
  assert.equal(agentTab("scripts", ["memory"], tabs), "memory");
  assert.equal(agentTab(undefined, ["list", "draft"], tabs), "draft");
  assert.equal(agentTab(undefined, [], tabs), "prompt");
});

test("a location reveals the call and the row it names in its run", () => {
  assert.deepEqual(
    revealedStep({
      section: "agents",
      agent: "a_1",
      tab: "history",
      item: "r_1",
      call: "c_1",
      seq: 0,
    }),
    { call: "c_1", seq: 0 },
  );
  assert.deepEqual(
    revealedStep({ section: "agents", agent: "a_1", tab: "history", item: "r_1" }),
    {},
  );
});
