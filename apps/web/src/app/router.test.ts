import assert from "node:assert/strict";
import { test } from "node:test";
import { router } from "./router";

function tableSearch(search: Record<string, unknown>) {
  const validate = router.routesById["/tables/$collectionId"].options.validateSearch;
  if (typeof validate !== "function") throw new TypeError("the table route validates its search");
  return validate(search);
}

function agentSearch(search: Record<string, unknown>) {
  const validate = router.routesById["/guilds/$guildId/agents/$agentId"].options.validateSearch;
  if (typeof validate !== "function") throw new TypeError("the agent route validates its search");
  return validate(search);
}

test("a table opens on a tab its search names, the records tab left out", () => {
  assert.deepEqual(tableSearch({ tab: "columns" }), { tab: "columns" });
  assert.deepEqual(tableSearch({ tab: "access" }), { tab: "access" });
  assert.deepEqual(tableSearch({ tab: "records" }), {});
});

test("a table's search without a known tab names none", () => {
  assert.deepEqual(tableSearch({ tab: "rows" }), {});
  assert.deepEqual(tableSearch({ tab: 2 }), {});
  assert.deepEqual(tableSearch({}), {});
});

test("an agent's chat opens a run on the step its search names", () => {
  assert.deepEqual(agentSearch({ run: "r1", call: "c1" }), { run: "r1", call: "c1" });
  assert.deepEqual(agentSearch({ run: "r1", seq: "4" }), { run: "r1", seq: 4 });
  assert.deepEqual(agentSearch({ run: "r1", call: "", seq: "-1" }), { run: "r1" });
  assert.deepEqual(agentSearch({ run: "r1", seq: "1.5" }), { run: "r1" });
});

test("a step without a run opens nothing", () => {
  assert.deepEqual(agentSearch({ call: "c1", seq: 4 }), {});
  assert.deepEqual(agentSearch({ run: "", call: "c1" }), {});
});

test('the session history drawer opens on true, "true" or 1', () => {
  assert.deepEqual(agentSearch({ history: true }), { history: true });
  assert.deepEqual(agentSearch({ history: "true" }), { history: true });
  assert.deepEqual(agentSearch({ history: 1 }), { history: true });
  assert.deepEqual(agentSearch({ history: "yes" }), {});
  assert.deepEqual(agentSearch({ run: "r1", history: false }), { run: "r1" });
});
