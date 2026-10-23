import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ARRAY_ITEM_MAX,
  ARRAY_ITEMS_MAX,
  COLUMN_DESCRIPTION_MAX,
  columnCatalog,
  describeColumn,
  identityFor,
  normalizeDatetime,
  parseColumnChange,
  parseColumns,
  recordProblems,
  recordRejected,
  validateAdd,
  validatePatch,
} from "../../src/artifacts/columns.js";

const columns = parseColumns([
  { name: "email", type: "text", description: "the contact's email", required: true, unique: true },
  { name: "status", type: "text", description: "pipeline state", values: ["new", "contacted", "won"], required: true },
  { name: "score", type: "number", description: "fit score" },
  { name: "active", type: "boolean", description: "still in play" },
  { name: "signed_up_at", type: "datetime", description: "when they signed up" },
  { name: "tags", type: "array", description: "labels" },
]);

test("parseColumns normalises a valid column list", () => {
  assert.deepEqual(columns[0], { name: "email", type: "text", description: "the contact's email", required: true, unique: true });
  assert.deepEqual(columns[1], {
    name: "status",
    type: "text",
    description: "pipeline state",
    required: true,
    unique: false,
    values: ["new", "contacted", "won"],
  });
  assert.deepEqual(columns[2], { name: "score", type: "number", description: "fit score", required: false, unique: false });
  assert.deepEqual(parseColumns([]), []);
});

test("parseColumns names the rule a column breaks", () => {
  const one = (column: Record<string, unknown>) => () => parseColumns([column]);
  assert.throws(() => parseColumns("nope"), /columns must be an array/);
  assert.throws(() => parseColumns([1]), /column 1: must be an object/);
  assert.throws(one({ name: "Bad Name", type: "text", description: "x" }), /name must match/);
  assert.throws(one({ name: "id", type: "text", description: "x" }), /column "id": name is reserved/);
  assert.throws(one({ name: "a", type: "json", description: "x" }), /type must be one of text, number, boolean, datetime, array/);
  assert.throws(one({ name: "a", type: "text" }), /column "a": description is required/);
  assert.doesNotThrow(one({ name: "a", type: "text", description: "x".repeat(COLUMN_DESCRIPTION_MAX) }));
  assert.throws(
    one({ name: "a", type: "text", description: "x".repeat(COLUMN_DESCRIPTION_MAX + 1) }),
    /at most 1000 characters/,
  );
  assert.throws(one({ name: "a", type: "text", description: "x", required: "yes" }), /required must be true or false/);
  assert.throws(one({ name: "a", type: "boolean", description: "x", unique: true }), /unique needs a text or number column/);
  assert.throws(one({ name: "a", type: "array", description: "x", unique: true }), /unique needs a text or number column/);
  assert.throws(one({ name: "a", type: "number", description: "x", values: ["1"] }), /values needs a text or array column/);
  assert.throws(one({ name: "a", type: "text", description: "x", values: [] }), /values must be a list of 1 to 50/);
  assert.throws(one({ name: "a", type: "text", description: "x", values: ["x", "x"] }), /values must be a list/);
  assert.throws(one({ name: "a", type: "text", description: "x", extra: 1 }), /unknown field "extra"/);
  assert.throws(
    () =>
      parseColumns([
        { name: "a", type: "text", description: "x" },
        { name: "a", type: "text", description: "y" },
      ]),
    /column "a": duplicate name/,
  );
  assert.throws(
    () =>
      parseColumns([
        { name: "a", type: "text", description: "x", unique: true },
        { name: "b", type: "number", description: "y", unique: true },
      ]),
    /only one column can be unique \(a, b\)/,
  );
  assert.throws(() => parseColumns(Array.from({ length: 65 }, (_, i) => ({ name: `c${i}`, type: "text", description: "x" }))), /at most 64 columns/);
});

test("validateAdd reports every problem at once and stores normalised values", () => {
  const good = validateAdd(columns, {
    email: "Jane@Acme.com",
    status: "new",
    score: 80,
    active: true,
    signed_up_at: "2026-09-22T12:00:00+02:00",
    tags: ["crm", "warm"],
  });
  assert.deepEqual(good.problems, []);
  assert.deepEqual(good.body, {
    email: "Jane@Acme.com",
    status: "new",
    score: 80,
    active: true,
    signed_up_at: "2026-09-22T10:00:00.000Z",
    tags: ["crm", "warm"],
  });
  const bad = validateAdd(columns, { status: "pending", score: "42", active: "yes", signed_up_at: "yesterday", notes: "x" });
  assert.deepEqual(bad.problems, [
    'column "notes": unknown column; declared columns are email, status, score, active, signed_up_at, tags',
    'column "email": required',
    'column "status": expected one of new, contacted, won; got "pending"',
    'column "score": expected number; got "42"',
    'column "active": expected true or false; got "yes"',
    'column "signed_up_at": expected an ISO 8601 datetime with a timezone; got "yesterday"',
  ]);
  // null on an optional column is dropped; null on a required one is a problem
  const nulls = validateAdd(columns, { email: "a@b.c", status: null, score: null });
  assert.deepEqual(nulls.problems, ['column "status": required']);
  assert.deepEqual(nulls.body, { email: "a@b.c" });
  assert.match(recordRejected(bad.problems).message, /^record rejected\n- column "notes"/);
  assert.equal(recordRejected(bad.problems).status, 422);
});

test("an array column stores a list of text and names the rule an item breaks", () => {
  const closed = parseColumns([
    { name: "labels", type: "array", description: "closed tags", values: ["red", "green"] },
  ]);
  assert.deepEqual(closed[0], {
    name: "labels",
    type: "array",
    description: "closed tags",
    required: false,
    unique: false,
    values: ["red", "green"],
  });
  assert.deepEqual(validateAdd(columns, { email: "a@b.c", status: "new", tags: [] }).body.tags, []);
  assert.deepEqual(validateAdd(columns, { email: "a@b.c", status: "new", tags: "crm" }).problems, [
    'column "tags": expected a list of text; got "crm"',
  ]);
  assert.deepEqual(validateAdd(columns, { email: "a@b.c", status: "new", tags: ["crm", 1] }).problems, [
    'column "tags": item 2: expected text; got 1',
  ]);
  assert.deepEqual(validateAdd(columns, { email: "a@b.c", status: "new", tags: ["crm", ""] }).problems, [
    'column "tags": item 2: expected text; got ""',
  ]);
  assert.deepEqual(validateAdd(columns, { email: "a@b.c", status: "new", tags: ["crm", "crm"] }).problems, [
    'column "tags": item 2: duplicate "crm"',
  ]);
  assert.deepEqual(validateAdd(closed, { labels: ["red", "blue"] }).problems, [
    'column "labels": item 2: expected one of red, green; got "blue"',
  ]);
  assert.deepEqual(validateAdd(closed, { labels: ["green", "red"] }).body, { labels: ["green", "red"] });
  assert.deepEqual(describeColumn(closed[0]!), "labels (array: red | green)");
  assert.match(
    validateAdd(columns, { email: "a@b.c", status: "new", tags: Array.from({ length: ARRAY_ITEMS_MAX + 1 }, (_, i) => `t${i}`) })
      .problems[0] ?? "",
    /at most 50 text items/,
  );
  assert.match(
    validateAdd(columns, { email: "a@b.c", status: "new", tags: ["x".repeat(ARRAY_ITEM_MAX + 1)] }).problems[0] ?? "",
    /at most 200 characters/,
  );
});

test("validatePatch validates only the patched columns and separates clears", () => {
  const patch = validatePatch(columns, { status: "won", score: null, email: null, active: "no" });
  assert.deepEqual(patch.set, { status: "won" });
  assert.deepEqual(patch.clear, ["score"]);
  assert.deepEqual(patch.problems, ['column "email": required; cannot be cleared', 'column "active": expected true or false; got "no"']);
  assert.deepEqual(validatePatch(columns, { unknown: 1 }).problems, [
    'column "unknown": unknown column; declared columns are email, status, score, active, signed_up_at, tags',
  ]);
});

test("recordProblems lists what a stored record breaks against the current columns", () => {
  assert.deepEqual(recordProblems(columns, { email: "a@b.c", status: "new" }), []);
  assert.deepEqual(recordProblems(columns, { email: "a@b.c", status: "old", score: "1", legacy: true }), [
    'column "legacy": unknown column; declared columns are email, status, score, active, signed_up_at, tags',
    'column "status": expected one of new, contacted, won; got "old"',
    'column "score": expected number; got "1"',
  ]);
});

test("identityFor normalises the unique value and ignores other columns", () => {
  assert.equal(identityFor(columns, { email: "  Jane@Acme.COM " }), "jane@acme.com");
  assert.equal(identityFor(columns, { status: "new" }), null);
  const numeric = parseColumns([{ name: "ticket", type: "number", description: "ticket number", unique: true }]);
  assert.equal(identityFor(numeric, { ticket: 42 }), "42");
  assert.equal(identityFor(numeric, { ticket: "42" }), null);
  assert.equal(identityFor(parseColumns([]), { email: "x" }), null);
});

test("normalizeDatetime requires a timezone and returns UTC", () => {
  assert.equal(normalizeDatetime("2026-09-22T10:00Z"), "2026-09-22T10:00:00.000Z");
  assert.equal(normalizeDatetime("2026-09-22T12:00:00.5+02:00"), "2026-09-22T10:00:00.500Z");
  assert.equal(normalizeDatetime("2026-09-22"), null);
  assert.equal(normalizeDatetime("2026-09-22T10:00:00"), null);
  assert.equal(normalizeDatetime("2026-13-40T10:00:00Z"), null);
});

test("describeColumn and columnCatalog print what agents read", () => {
  assert.deepEqual(columns.map(describeColumn), [
    "email (text, required, unique)",
    "status (text: new | contacted | won, required)",
    "score (number)",
    "active (boolean)",
    "signed_up_at (datetime)",
    "tags (array)",
  ]);
  assert.deepEqual(columnCatalog(columns).slice(0, 2), [
    { name: "email", type: "text", required: true, unique: true, description: "the contact's email" },
    { name: "status", type: "text", values: ["new", "contacted", "won"], required: true, description: "pipeline state" },
  ]);
});

test("parseColumnChange finds renamed and removed columns", () => {
  const change = parseColumnChange(columns, [
    { name: "email", type: "text", description: "the contact's email", required: true, unique: true },
    { name: "stage", rename_from: "status", type: "text", description: "pipeline state", values: ["new", "won"], required: true },
    { name: "score", type: "number", description: "fit score" },
  ]);
  assert.deepEqual(change.renamed, [{ from: "status", to: "stage" }]);
  assert.deepEqual(change.removed, ["active", "signed_up_at", "tags"]);
  assert.deepEqual(
    change.columns.map((column) => column.name),
    ["email", "stage", "score"],
  );
  assert.throws(
    () => parseColumnChange(columns, [{ name: "x", rename_from: "nope", type: "text", description: "y" }]),
    /rename_from must name a current column/,
  );
});
