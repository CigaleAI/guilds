import assert from "node:assert/strict";
import { test } from "node:test";
import { parseColumns } from "../../src/artifacts/columns.js";
import { recordListHint } from "../../src/artifacts/records.js";
import { planCollection, planCollectionChange } from "../../src/artifacts/collections.js";

const COLUMNS = [
  { name: "project", type: "text", description: "project name", required: true },
  { name: "handled", type: "boolean", description: "picked up by the desk", required: true },
  { name: "status", type: "text", description: "queue state", values: ["new", "done"] },
];

const LIVE = { name: "scout-board", purpose: "Projects the desk follows", columns: parseColumns(COLUMNS) };

test("planCollection returns the checked definition with the display path it takes", () => {
  const planned = planCollection("org_1", { name: " leads ", purpose: " Qualified leads ", columns: COLUMNS });
  assert.equal(planned.name, "leads");
  assert.equal(planned.purpose, "Qualified leads");
  assert.deepEqual(planned.columns, parseColumns(COLUMNS));
  assert.equal(planned.href, "org/org_1/collections/leads");
});

test("planCollection takes no columns as an empty list", () => {
  assert.deepEqual(planCollection("org_1", { name: "leads", purpose: "Leads" }).columns, []);
});

test("planCollection refuses the name first, then the purpose, then the columns", () => {
  assert.throws(() => planCollection("org_1", { name: "Bad Name", purpose: "", columns: "x" }), /collection name must match/);
  assert.throws(() => planCollection("org_1", { name: "leads", purpose: "", columns: "x" }), /purpose is required/);
  assert.throws(() => planCollection("org_1", { name: "leads", purpose: "Leads", columns: "x" }), /columns/);
});

test("planCollectionChange keeps what the change leaves out", () => {
  assert.deepEqual(planCollectionChange(LIVE, {}), { name: LIVE.name, purpose: LIVE.purpose, columns: null });
});

test("planCollectionChange checks a new name and purpose and parses a column change against the live columns", () => {
  const planned = planCollectionChange(LIVE, {
    name: "board",
    purpose: "The board",
    columns: [...COLUMNS.slice(0, 2), { rename_from: "status", name: "state", type: "text", description: "queue state" }],
  });
  assert.equal(planned.name, "board");
  assert.equal(planned.purpose, "The board");
  assert.deepEqual(planned.columns?.renamed, [{ from: "status", to: "state" }]);
  assert.deepEqual(planned.columns?.removed, []);
});

test("planCollectionChange refuses the name first, then the purpose, then the columns", () => {
  assert.throws(() => planCollectionChange(LIVE, { name: "Bad Name", purpose: "", columns: "x" }), /collection name must match/);
  assert.throws(() => planCollectionChange(LIVE, { purpose: "", columns: "x" }), /purpose is required/);
  assert.throws(() => planCollectionChange(LIVE, { columns: "x" }), /columns must be an array/);
});

const FACTS = { name: "scout-board", count: 11, newest_updated_at: "2026-09-22T05:42:10Z", columns: parseColumns(COLUMNS) };

test("recordListHint names a where listing, what the collection holds, and its columns", () => {
  const hint = recordListHint({ collection: "scout-board", where: { handled: false } }, FACTS);
  assert.match(
    hint,
    /^No records in scout-board where \{"handled":false\}\. scout-board holds 11 records; the newest changed at 2026-09-22T05:42:10Z\./,
  );
  assert.match(hint, /Its columns: project \(text, required\); handled \(boolean, required\); status \(text: new \| done\)\./);
  assert.match(hint, /a larger limit will not change it\. where matches by column type/);
});

test("recordListHint points a since listing at where and record_search, and says when the collection is empty", () => {
  const hint = recordListHint({ collection: "fresh", since: "2026-09-22T06:13:00Z" }, { ...FACTS, name: "fresh", count: 0, newest_updated_at: null });
  assert.match(hint, /^No records in fresh changed at or after 2026-09-22T06:13:00Z\. fresh holds no records yet\./);
  assert.match(hint, /since is for picking up new work — to check whether something is already recorded, use where on the unique column or record_search/);
});

test("recordListHint names both narrowings, counts one record, and leaves out the columns of a collection without any", () => {
  const hint = recordListHint(
    { collection: "bare", where: { id: 3 }, since: "2026-09-22T06:13:00Z" },
    { name: "bare", count: 1, newest_updated_at: "2026-09-22T05:42:10Z", columns: [] },
  );
  assert.match(hint, /^No records in bare changed at or after 2026-09-22T06:13:00Z, where \{"id":3\}\. bare holds 1 record;/);
  assert.doesNotMatch(hint, /Its columns/);
});
