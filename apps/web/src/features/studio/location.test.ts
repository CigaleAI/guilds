import assert from "node:assert/strict";
import { test } from "node:test";
import { focusLocation, parseStudioSearch } from "./location";

test("a pin opens the inspector where its evidence is", () => {
  assert.deepEqual(
    focusLocation({
      kind: "run",
      label: "",
      agent_id: "a_1",
      run_id: "r_1",
      call_id: "c_1",
      seq: 4,
    }),
    { agent: "a_1", tab: "history", item: "r_1", call: "c_1", seq: 4 },
  );
  assert.deepEqual(
    focusLocation({ kind: "memory_version", label: "", agent_id: "a_1", revision_id: null }),
    {
      agent: "a_1",
      tab: "memory",
      item: "live",
    },
  );
  assert.deepEqual(
    focusLocation({
      kind: "file",
      label: "",
      agent_id: "a_1",
      display_path: "org/o/agents/a_1/scripts/calc_valuation.py",
    }),
    { agent: "a_1", tab: "scripts", item: "calc_valuation" },
  );
  assert.deepEqual(
    focusLocation({ kind: "file", label: "", display_path: "org/o/guilds/g/notes/a.md" }),
    { tab: "files", item: "org/o/guilds/g/notes/a.md" },
  );
  assert.equal(focusLocation({ kind: "issue", label: "" }), null);
});

test("the URL keeps only tabs the target has", () => {
  assert.deepEqual(parseStudioSearch({ tab: "memory" }), {});
  assert.deepEqual(parseStudioSearch({ agent: "a_1", tab: "memory", seq: "3" }), {
    agent: "a_1",
    tab: "memory",
    seq: 3,
  });
  assert.deepEqual(parseStudioSearch({ tab: "overview", item: "link:operator>a_1" }), {
    tab: "overview",
    item: "link:operator>a_1",
  });
});
