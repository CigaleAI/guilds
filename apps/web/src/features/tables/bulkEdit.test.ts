import assert from "node:assert/strict";
import { test } from "node:test";
import type { CollectionRecord, Column } from "../../api/types/tables";
import {
  bulkEditBody,
  bulkEditSends,
  bulkEditTargets,
  chosenColumn,
  recordIdsText,
  recordsInSelection,
  recordsUpdatedToast,
} from "./bulkEdit";

function column(name: string, type: Column["type"], extra: Partial<Column> = {}): Column {
  return { name, type, description: "", required: false, unique: false, ...extra };
}

function record(id: number): CollectionRecord {
  return {
    id,
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    updated_by: null,
    version: 1,
    display_path: "",
  };
}

test("the selection keeps only the shown records, in the order shown", () => {
  assert.deepEqual(
    recordsInSelection([record(3), record(1), record(2)], new Set([1, 3, 9])),
    [3, 1],
  );
  assert.deepEqual(recordsInSelection([], new Set([1])), []);
});

test("a bulk edit sends the field as its column's typed value, and null when the field is empty", () => {
  assert.deepEqual(bulkEditBody(column("score", "number"), "7", 2), { body: { score: 7 } });
  assert.deepEqual(bulkEditBody(column("active", "boolean"), "false", 2), {
    body: { active: false },
  });
  assert.deepEqual(bulkEditBody(column("tags", "array"), "a, , b", 2), {
    body: { tags: ["a", "b"] },
  });
  assert.deepEqual(bulkEditBody(column("seen", "datetime"), "2026-01-02T03:04:00Z", 2), {
    body: { seen: "2026-01-02T03:04:00.000Z" },
  });
  assert.deepEqual(bulkEditBody(column("note", "text"), " hi ", 2), { body: { note: " hi " } });
  assert.deepEqual(bulkEditBody(column("note", "text"), "", 2), { body: { note: null } });
});

test("a bulk edit refuses what the column refuses, as the record dialog does", () => {
  assert.deepEqual(bulkEditBody(column("score", "number"), "x", 2), { error: "A number." });
  assert.deepEqual(bulkEditBody(column("score", "number", { required: true }), "", 2), {
    error: "Required.",
  });
  assert.deepEqual(bulkEditBody(column("tags", "array", { values: ["red"] }), "red, blue", 2), {
    error: "Only red.",
  });
});

test("a unique column takes a value on one record, and clearing on any number", () => {
  const email = column("email", "text", { unique: true });
  assert.deepEqual(bulkEditBody(email, "a@b.c", 2), {
    error: "Unique: one record at most can hold a value. Clear it, or edit one record.",
  });
  assert.deepEqual(bulkEditBody(email, "a@b.c", 1), { body: { email: "a@b.c" } });
  assert.deepEqual(bulkEditBody(email, "", 2), { body: { email: null } });
});

test("a save sends the first save's value once there was one, else the field's value when it is taken", () => {
  assert.deepEqual(bulkEditSends(null, { body: { score: 7 } }), { score: 7 });
  assert.equal(bulkEditSends(null, { error: "A number." }), null);
  assert.equal(bulkEditSends(null, null), null);
  assert.deepEqual(bulkEditSends({ score: 9 }, { body: { score: 11 } }), { score: 9 });
  assert.deepEqual(bulkEditSends({ score: 9 }, { error: "A number." }), { score: 9 });
});

test("the column chosen is the one named, and none before one is or once the table lost it", () => {
  const columns = [column("score", "number"), column("tags", "array")];
  assert.equal(chosenColumn(columns, "tags"), columns[1]);
  assert.equal(chosenColumn(columns, ""), undefined);
  assert.equal(chosenColumn(columns, "gone"), undefined);
  assert.equal(chosenColumn([], ""), undefined);
});

test("the next save sends to the records the last one refused, or else to every one asked", () => {
  assert.deepEqual(bulkEditTargets([1, 2, 3], []), [1, 2, 3]);
  assert.deepEqual(bulkEditTargets([1, 2, 3], [{ recordId: 2, reason: "x" }]), [2]);
});

test("record ids are named with their hash, in the order given", () => {
  assert.equal(recordIdsText([3, 1]), "#3, #1");
  assert.equal(recordIdsText([]), "");
});

test("the saved toast counts the records, and names each one whose other values still do not fit", () => {
  assert.deepEqual(recordsUpdatedToast("score", [{ recordId: 1, warnings: [] }]), {
    kind: "success",
    title: "Saved score on 1 record",
  });
  assert.deepEqual(
    recordsUpdatedToast("score", [
      { recordId: 1, warnings: [] },
      { recordId: 2, warnings: ['column "a": expected number', 'column "b": unknown'] },
      { recordId: 3, warnings: ['column "a": expected number'] },
    ]),
    {
      kind: "warning",
      title: "Saved score on 3 records",
      description:
        'Still not fitting: #2: column "a": expected number; column "b": unknown\n#3: column "a": expected number',
    },
  );
});
