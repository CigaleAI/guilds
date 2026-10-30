import assert from "node:assert/strict";
import { test } from "node:test";
import { router } from "./router";

function tableSearch(search: Record<string, unknown>) {
  const validate = router.routesById["/tables/$collectionId"].options.validateSearch;
  if (typeof validate !== "function") throw new TypeError("the table route validates its search");
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
