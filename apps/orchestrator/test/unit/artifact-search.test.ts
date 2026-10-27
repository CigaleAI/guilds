import assert from "node:assert/strict";
import { test } from "node:test";
import { parseColumns } from "../../src/artifacts/columns.js";
import {
  parseLimit,
  parseOffset,
  parseOrder,
  parseRecordId,
  parseSince,
  parseWhere,
  SEARCH_BLOB_MAX_BYTES,
  searchBlobFor,
} from "../../src/artifacts/search.js";
import { allowsSimilarSpelling, isSingleToken } from "../../src/db/collections.js";

const columns = parseColumns([
  { name: "project", type: "text", description: "project name" },
  { name: "status", type: "text", description: "pipeline state", values: ["new", "done"], required: true },
  { name: "score", type: "number", description: "fit score" },
  { name: "handled", type: "boolean", description: "picked up" },
  { name: "seen_at", type: "datetime", description: "when it was seen" },
  { name: "tags", type: "array", description: "labels" },
  { name: "labels", type: "array", description: "closed tags", values: ["red", "green"] },
]);

test("searchBlobFor flattens scalar values depth first and leaves keys out", () => {
  const blob = searchBlobFor("42", {
    handled: false,
    project: "Zebra",
    identity: { chain: "Zcash launchpad", venue: null, asset: undefined },
    rankings: { novelty: 1, tags: ["privacy", "launchpad"] },
  });
  assert.equal(blob, "42 false Zebra Zcash launchpad 1 privacy launchpad");
  assert.equal(blob.includes("handled"), false);
  assert.equal(searchBlobFor("7", {}), "7");
});

test("searchBlobFor caps the indexed text at the byte budget", () => {
  const blob = searchBlobFor("1", { text: "é".repeat(SEARCH_BLOB_MAX_BYTES) });
  assert.ok(Buffer.byteLength(blob, "utf8") <= SEARCH_BLOB_MAX_BYTES);
  assert.equal(blob.includes("�"), false);
});

test("parseRecordId accepts positive integers as numbers or strings", () => {
  assert.equal(parseRecordId(42), 42);
  assert.equal(parseRecordId(" 7 "), 7);
  assert.throws(() => parseRecordId(0), /positive integer/);
  assert.throws(() => parseRecordId("abc"), /positive integer/);
  assert.throws(() => parseRecordId(1.5), /positive integer/);
  assert.throws(() => parseRecordId(null), /positive integer/);
});

test("parseWhere types every term by its column", () => {
  assert.deepEqual(parseWhere(undefined, columns), []);
  assert.deepEqual(
    parseWhere(
      { id: "12", project: " Zeb ", status: "new", score: 3, handled: false, seen_at: "2026-09-21T10:00:00+02:00", tags: "crm" },
      columns,
    ),
    [
      { column: "id", op: "id", id: 12 },
      { column: "project", type: "text", op: "like", term: "Zeb" },
      { column: "status", type: "text", op: "eq", term: "new" },
      { column: "score", type: "number", op: "eq", term: 3 },
      { column: "handled", type: "boolean", op: "eq", term: false },
      { column: "seen_at", type: "datetime", op: "eq", term: "2026-09-21T08:00:00.000Z" },
      { column: "tags", type: "array", op: "like", term: "crm" },
    ],
  );
});

test("parseWhere matches null, ranges, and rejects terms outside a closed list", () => {
  assert.deepEqual(parseWhere({ project: null }, columns), [{ column: "project", type: "text", op: "null" }]);
  assert.deepEqual(parseWhere({ score: { gte: 2, lte: 5 } }, columns), [
    { column: "score", type: "number", op: "range", gte: 2, lte: 5 },
  ]);
  assert.deepEqual(parseWhere({ seen_at: { gte: "2026-09-01T00:00:00Z" } }, columns), [
    { column: "seen_at", type: "datetime", op: "range", gte: "2026-09-01T00:00:00.000Z", lte: null },
  ]);
  assert.throws(() => parseWhere({ status: "pending" }, columns), /where\.status: expected one of new, done; got "pending"/);
  assert.throws(() => parseWhere({ notes: "x" }, columns), /where\.notes: unknown column; declared columns are project, status, score, handled, seen_at, tags, labels/);
  assert.throws(() => parseWhere({ tags: 1 }, columns), /where\.tags: expected text; got 1/);
  assert.throws(() => parseWhere({ labels: "blue" }, columns), /where\.labels: expected one of red, green/);
  assert.deepEqual(parseWhere({ labels: "red" }, columns), [{ column: "labels", type: "array", op: "contains", term: "red" }]);
  assert.throws(() => parseWhere({ score: "high" }, columns), /where\.score: expected number; got "high"/);
  assert.throws(() => parseWhere({ handled: "yes" }, columns), /where\.handled: expected true or false/);
  assert.throws(() => parseWhere({ seen_at: "yesterday" }, columns), /where\.seen_at: expected an ISO 8601 datetime with a timezone/);
  assert.throws(() => parseWhere({ project: { gte: "a" } }, columns), /a range needs a number or datetime column/);
  assert.throws(() => parseWhere({ score: { above: 1 } }, columns), /a range is/);
  assert.throws(() => parseWhere({ score: {} }, columns), /a range is/);
  assert.throws(() => parseWhere({ project: 42 }, columns), /where\.project: expected text; got 42/);
  assert.throws(() => parseWhere({ id: "x" }, columns), /where\.id must be a positive integer/);
  assert.throws(() => parseWhere("open", columns), /where must be an object/);
  assert.throws(
    () => parseWhere(Object.fromEntries(Array.from({ length: 9 }, (_, i) => [`f${i}`, "x"])), columns),
    /at most 8 columns/,
  );
  assert.throws(() => parseWhere({ project: "x".repeat(201) }, columns), /at most 200 characters/);
});

test("parseOrder accepts declared and system columns as an object or a string", () => {
  assert.equal(parseOrder(undefined, columns), null);
  assert.deepEqual(parseOrder({ column: "score", direction: "desc" }, columns), { column: "score", direction: "desc" });
  assert.deepEqual(parseOrder({ column: "updated_at" }, columns), { column: "updated_at", direction: "asc" });
  assert.deepEqual(parseOrder("id desc", columns), { column: "id", direction: "desc" });
  assert.throws(() => parseOrder({ column: "tags" }, columns), /order\.column cannot be an array column/);
  assert.throws(() => parseOrder({ column: "nope" }, columns), /order\.column must be one of id, created_at, updated_at, project/);
  assert.throws(() => parseOrder({ column: "score", direction: "up" }, columns), /asc or desc/);
  assert.throws(() => parseOrder(7, columns), /order must be/);
});

test("parseLimit and parseOffset clamp and reject junk", () => {
  assert.equal(parseLimit(undefined, 20, 100), 20);
  assert.equal(parseLimit("500", 20, 100), 100);
  assert.equal(parseLimit(0, 20, 100), 1);
  assert.throws(() => parseLimit("many", 20, 100), /positive integer/);
  assert.equal(parseOffset(undefined), 0);
  assert.equal(parseOffset("40"), 40);
  assert.throws(() => parseOffset(-1), /non-negative/);
});

test("isSingleToken is true only for a query without whitespace", () => {
  assert.equal(isSingleToken("ZECDUG"), true);
  assert.equal(isSingleToken("0x1a2b"), true);
  assert.equal(isSingleToken("Zdacted OR ZECDUG"), false);
  assert.equal(isSingleToken(""), false);
});

test("allowsSimilarSpelling is false for terms with digits", () => {
  assert.equal(allowsSimilarSpelling("Zecrod"), true);
  assert.equal(allowsSimilarSpelling("2026-09-21"), false);
  assert.equal(allowsSimilarSpelling("0x1a2b3c"), false);
  assert.equal(allowsSimilarSpelling("web3"), false);
});

test("parseSince normalises timestamps and rejects other text", () => {
  assert.equal(parseSince(undefined), null);
  assert.equal(parseSince(""), null);
  assert.equal(parseSince("2026-09-21T08:00:00Z"), "2026-09-21T08:00:00.000Z");
  assert.equal(parseSince("2026-09-21T10:00:00+02:00"), "2026-09-21T08:00:00.000Z");
  assert.throws(() => parseSince("yesterday"), /ISO 8601/);
  assert.throws(() => parseSince(12), /ISO 8601/);
});
