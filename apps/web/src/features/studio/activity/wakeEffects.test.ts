import assert from "node:assert/strict";
import { test } from "node:test";
import { call, wake, write } from "./activityFixtures";
import { groupWrites, recordIdFromPath, wakeEffects } from "./wakeEffects";

test("a wake's effects split tool calls from posts, writes, script runs and issue reports", () => {
  const effects = wakeEffects(
    wake("w_1", "a_wallet", [0, 1], {
      tool_calls: [
        call("wallet_get_balance", '{"chain":"base"}', "wallet credentials are missing"),
        call("coingecko_prices"),
        call("script_run", '{"name":"rh-balance"}'),
        call("script_run", '{"name":"rh-balance"}'),
        call("report_issue", '{"kind":"api","detail":"Keys are missing"}'),
        call("group_post", '{"content":"hi"}'),
        call("memory_write"),
      ],
      writes: [
        write("note", "valuation.md", "org/o/notes/valuation.md", "update"),
        write("memory", "memory.md", "org/o/agents/a/memory.md", "update"),
        write("script", "calc", "org/o/agents/a/scripts/calc", "create"),
      ],
    }),
  );
  assert.deepEqual(
    effects.calls.map((item) => item.name),
    ["wallet_get_balance", "coingecko_prices"],
  );
  assert.deepEqual(effects.scriptRuns, [{ value: "rh-balance", count: 2 }]);
  assert.deepEqual(effects.issues, ["Keys are missing"]);
  assert.deepEqual(
    effects.failedCalls.map((item) => item.error),
    ["wallet credentials are missing"],
  );
  assert.deepEqual(
    [
      effects.records.length,
      effects.notes.map((group) => group.target),
      effects.scripts.map((group) => group.target),
    ],
    [0, ["valuation.md"], ["calc"]],
  );
  assert.equal(effects.memory, true);
});

test("writes group by what they touched, with record ids and the first write", () => {
  const writes = [
    write("record", "projects", "org/o/collections/projects/7", "update"),
    write("record", "projects", "org/o/collections/projects/8", "create"),
    write("memory", "memory.md", "org/o/agents/a/memory.md", "update"),
    write("record", "projects", "org/o/collections/projects/7", "update"),
    write("note", "42", "org/o/notes/42", "create"),
  ];
  assert.deepEqual(groupWrites(writes), [
    {
      kind: "record",
      target: "projects",
      count: 3,
      operations: { update: 2, create: 1 },
      ids: ["7", "8"],
      first: writes[0],
    },
    {
      kind: "memory",
      target: "memory.md",
      count: 1,
      operations: { update: 1 },
      ids: [],
      first: writes[2],
    },
    { kind: "note", target: "42", count: 1, operations: { create: 1 }, ids: [], first: writes[4] },
  ]);
  assert.deepEqual(groupWrites(null), []);
});

test("a record id is the numeric last part of a display path", () => {
  assert.equal(recordIdFromPath("org/o/collections/projects/42"), "42");
  assert.equal(recordIdFromPath("org/o/notes/plan.md"), null);
  assert.equal(recordIdFromPath("org/o/collections/projects/42/"), null);
  assert.equal(recordIdFromPath(""), null);
  assert.equal(recordIdFromPath(null), null);
});
