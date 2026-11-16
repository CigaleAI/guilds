import assert from "node:assert/strict";
import { test } from "node:test";
import type { CollectionRecord, Column } from "../../api/types/tables";
import { bulkEditBody, recordsInSelection, recordsUpdatedToast } from "./bulkEdit";

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
  assert.deepEqual(recordsInSelection([record(3), record(1), record(2)], new Set([1, 3, 9])), [3, 1]);
  assert.deepEqual(recordsInSelection([], new Set([1])), []);
});

test("a bulk edit sends the field as its column's typed value, and null when the field is empty", () => {
  assert.deepEqual(bulkEditBody(column("score", "number"), "7"), { body: { score: 7 } });
  assert.deepEqual(bulkEditBody(column("active", "boolean"), "false"), { body: { active: false } });
  assert.deepEqual(bulkEditBody(column("tags", "array"), "a, , b"), { body: { tags: ["a", "b"] } });
  assert.deepEqual(bulkEditBody(column("seen", "datetime"), "2026-01-02T03:04:00Z"), {
    body: { seen: "2026-01-02T03:04:00.000Z" },
  });
  assert.deepEqual(bulkEditBody(column("note", "text"), " hi "), { body: { note: " hi " } });
  assert.deepEqual(bulkEditBody(column("note", "text"), ""), { body: { note: null } });
});

test("a bulk edit refuses what the column refuses, as the record dialog does", () => {
  assert.deepEqual(bulkEditBody(column("score", "number"), "x"), { error: "A number." });
  assert.deepEqual(bulkEditBody(column("score", "number", { required: true }), ""), { error: "Required." });
  assert.deepEqual(bulkEditBody(column("tags", "array", { values: ["red"] }), "red, blue"), {
    error: "Only red.",
  });
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
