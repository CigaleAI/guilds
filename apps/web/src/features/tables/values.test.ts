import assert from "node:assert/strict";
import { test } from "node:test";
import type { Column } from "../../api/types/tables";
import {
  columnErrors,
  columnsForSave,
  describeChanges,
  fieldText,
  fits,
  isColumnType,
  isTableTab,
  parseField,
  whereOf,
} from "./values";

function column(name: string, type: Column["type"], extra: Partial<Column> = {}): Column {
  return { name, type, description: "d", required: false, unique: false, ...extra };
}

test("a column type is one the server stores", () => {
  assert.equal(isColumnType("datetime"), true);
  assert.equal(isColumnType("date"), false);
});

test("a table tab is records, columns or access", () => {
  assert.equal(isTableTab("columns"), true);
  assert.equal(isTableTab("settings"), false);
  assert.equal(isTableTab(undefined), false);
});

test("values fit their column, including allowed values", () => {
  assert.equal(fits("watch", column("status", "text", { values: ["watch", "ignore"] })), true);
  assert.equal(fits("other", column("status", "text", { values: ["watch", "ignore"] })), false);
  assert.equal(fits("3", column("score", "number")), false);
  assert.equal(fits(null, column("score", "number")), true);
  assert.equal(fits(["a"], column("tags", "array")), true);
});

test("form text becomes a typed value, null when empty", () => {
  assert.deepEqual(parseField(" 42 ", column("score", "number")), { value: 42 });
  assert.deepEqual(parseField("abc", column("score", "number")), { error: "A number." });
  assert.deepEqual(parseField("", column("score", "number")), { value: null });
  assert.deepEqual(parseField("a, b ,,c", column("tags", "array")), { value: ["a", "b", "c"] });
  assert.deepEqual(parseField("true", column("done", "boolean")), { value: true });
  assert.equal(fieldText(["a", "b"], column("tags", "array")), "a, b");
});

test("filters become the server's where", () => {
  const columns = [column("score", "number"), column("status", "text"), column("done", "boolean")];
  assert.deepEqual(
    whereOf(
      {
        id: { value: "7" },
        score: { from: "10", to: "20" },
        status: { value: "(empty)" },
        done: { value: "true" },
      },
      columns,
    ),
    { id: 7, score: { gte: 10, lte: 20 }, status: null, done: true },
  );
  assert.deepEqual(whereOf({ score: { from: "5", to: "5" } }, columns), { score: 5 });
});

test("columns for save drop empty values and values on the wrong type", () => {
  assert.deepEqual(
    columnsForSave([
      {
        name: " date ",
        type: "datetime",
        description: " when ",
        required: false,
        unique: false,
        values: [],
      },
      {
        name: "status",
        type: "text",
        description: "state",
        required: true,
        unique: false,
        values: ["open", "closed"],
      },
      {
        name: "note",
        type: "text",
        description: "free",
        required: false,
        unique: false,
        values: [],
      },
    ]),
    [
      { name: "date", type: "datetime", description: "when", required: false, unique: false },
      {
        name: "status",
        type: "text",
        description: "state",
        required: true,
        unique: false,
        values: ["open", "closed"],
      },
      { name: "note", type: "text", description: "free", required: false, unique: false },
    ],
  );
});

test("column definitions are checked like the server does", () => {
  const errors = columnErrors([
    column("id", "text"),
    column("Name", "text"),
    column("slug", "text", { unique: true }),
    column("score", "number", { unique: true }),
    column("tags", "array", { unique: false, description: "" }),
  ]);
  assert.match(errors.get(0) ?? "", /reserved/);
  assert.match(errors.get(1) ?? "", /Lowercase/);
  assert.equal(errors.has(2), false);
  assert.match(errors.get(3) ?? "", /one column/);
  assert.match(errors.get(4) ?? "", /Describe/);
});

test("a columns edit is described change by change", () => {
  const before = [column("status", "text"), column("score", "number"), column("old", "text")];
  const after = [
    { ...column("state", "text"), rename_from: "status" },
    column("score", "text"),
    column("added", "boolean"),
  ];
  assert.deepEqual(describeChanges(before, after), [
    "Rename status to state",
    "Change score from number to text",
    "Add added (boolean)",
    "Remove old and its values",
  ]);
});

test("a description-only edit is a change", () => {
  assert.deepEqual(
    describeChanges(
      [column("status", "text")],
      [column("status", "text", { description: "state" })],
    ),
    ["Change the description of status"],
  );
});
