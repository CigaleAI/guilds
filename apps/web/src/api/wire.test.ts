import assert from "node:assert/strict";
import { test } from "node:test";
import {
  hasFields,
  isBoolean,
  isJsonObject,
  isJsonValue,
  isListOf,
  isNumber,
  isNumberOrNull,
  isString,
  isStringList,
  isStringOrNull,
  parseJson,
  parseStudioConnection,
  parseStudioEdit,
} from "./wire";

test("the scalar checks admit their own kind only", () => {
  assert.equal(isString("a"), true);
  assert.equal(isString(1), false);
  assert.equal(isNumber(1), true);
  assert.equal(isNumber("1"), false);
});

test("the nullable and boolean checks admit their own kind only", () => {
  assert.equal(isBoolean(false), true);
  assert.equal(isBoolean(0), false);
  assert.equal(isStringOrNull(null), true);
  assert.equal(isStringOrNull("a"), true);
  assert.equal(isStringOrNull(undefined), false);
  assert.equal(isNumberOrNull(null), true);
  assert.equal(isNumberOrNull(2), true);
  assert.equal(isNumberOrNull("2"), false);
});

test("isListOf admits a list whose every item passes", () => {
  assert.equal(isListOf(["a", "b"], isString), true);
  assert.equal(isListOf([], isString), true);
  assert.equal(isListOf(["a", 1], isString), false);
  assert.equal(isListOf("a", isString), false);
  assert.equal(isStringList(["a"]), true);
  assert.equal(isStringList([null]), false);
});

test("hasFields checks every named field, a missing one included", () => {
  assert.equal(hasFields({ a: "x", b: "y" }, ["a", "b"], isString), true);
  assert.equal(hasFields({ a: "x" }, ["a", "b"], isString), false);
  assert.equal(hasFields({ a: "x", b: 2 }, ["a", "b"], isString), false);
});

test("isJsonValue accepts what JSON carries and refuses the rest", () => {
  assert.equal(isJsonValue({ a: [1, "two", true, null, { b: 3 }] }), true);
  assert.equal(isJsonValue("text"), true);
  assert.equal(isJsonValue(undefined), false);
  assert.equal(isJsonValue([1, () => 2]), false);
  assert.equal(isJsonValue([undefined]), false);
  assert.equal(isJsonValue({ a: { b: undefined } }), true);
});

test("isJsonObject accepts an object of JSON values only", () => {
  assert.equal(isJsonObject({ path: "a.md", offset: 3 }), true);
  assert.equal(isJsonObject({}), true);
  assert.equal(isJsonObject(null), false);
  assert.equal(isJsonObject(["a"]), false);
  assert.equal(isJsonObject("{}"), false);
  assert.equal(isJsonObject({ when: new Date(0) }), false);
});

test("parseJson reads the value a JSON text holds", () => {
  assert.deepEqual(parseJson('{"run_id":"r2"}'), { run_id: "r2" });
  assert.equal(parseJson("null"), null);
});

test("parseJson is undefined for a text that is not JSON", () => {
  assert.equal(parseJson("{oops"), undefined);
  assert.equal(parseJson(""), undefined);
});

test("parseStudioEdit keeps every field that holds what it names", () => {
  const edit = {
    kind: "access",
    action: "edit",
    target: { agent_id: "a_1", collection_id: null },
    base_version: 3,
    fields: ["about"],
    lines: { added: 2, removed: 1 },
    changes: [{ kind: "mcp", id: "conn_1", label: "Notion", setting: "on" }],
    widens: true,
  };
  assert.deepEqual(parseStudioEdit(edit), edit);
});

test("parseStudioEdit drops a field of the wrong type and an access change it cannot read", () => {
  assert.deepEqual(
    parseStudioEdit({
      kind: "secret",
      action: 2,
      target: { agent_id: 7, schedule_id: "sch_1" },
      base_version: "3",
      fields: ["about", 4],
      lines: { added: "2" },
      changes: [
        { kind: "mcp", id: "conn_1", label: "Notion", setting: "maybe" },
        { kind: "native_tool", id: "web_fetch", label: "Fetch", setting: "off" },
        "on",
      ],
      widens: "yes",
    }),
    {
      target: { schedule_id: "sch_1" },
      fields: ["about"],
      lines: {},
      changes: [{ kind: "native_tool", id: "web_fetch", label: "Fetch", setting: "off" }],
    },
  );
  assert.deepEqual(parseStudioEdit(null), {});
  assert.deepEqual(parseStudioEdit(["memory"]), {});
});

test("parseStudioConnection keeps the text fields of the connection and its server", () => {
  assert.deepEqual(
    parseStudioConnection({
      id: "conn_1",
      owner_scope: "org",
      account_hint: 5,
      server: { slug: "notion", display_name: null },
    }),
    { id: "conn_1", owner_scope: "org", server: { slug: "notion" } },
  );
  assert.deepEqual(parseStudioConnection("conn_1"), {});
});
