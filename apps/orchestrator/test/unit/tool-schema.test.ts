import assert from "node:assert/strict";
import { test } from "node:test";
import { Type } from "typebox";
import {
  decodeArguments,
  isToolSchema,
  llmToolParameters,
  offeredParameters,
  omitEmptyOptionalStrings,
} from "../../src/lib/tool-schema.js";

test("omitEmptyOptionalStrings drops empty optional keys only", () => {
  const schema = {
    type: "object",
    properties: {
      tweetId: { type: "string" },
      agentId: { type: "string" },
      campaignId: { type: "string" },
      prompt: { type: "string" },
    },
    required: ["tweetId", "agentId"],
  };
  assert.deepEqual(
    omitEmptyOptionalStrings(
      {
        tweetId: "",
        agentId: "11111111-1111-1111-1111-111111111111",
        campaignId: "",
        prompt: "Reply",
      },
      schema,
    ),
    {
      tweetId: "",
      agentId: "11111111-1111-1111-1111-111111111111",
      prompt: "Reply",
    },
  );
  assert.deepEqual(
    omitEmptyOptionalStrings({ campaignId: "", keep: "x" }, { type: "object" }),
    { campaignId: "", keep: "x" },
  );
  assert.deepEqual(
    omitEmptyOptionalStrings({ extra: "", campaignId: "" }, schema),
    { extra: "" },
  );
});

test("isToolSchema reads the keywords tool calling reads at every depth, boolean schemas included", () => {
  assert.equal(
    isToolSchema({
      type: "object",
      properties: { any: true, tags: { type: "array", items: { type: "string" }, minItems: 1 } },
      required: ["any"],
    }),
    true,
  );
  assert.equal(isToolSchema({ type: "object", properties: { nested: { type: "object", required: true } } }), false);
  assert.equal(isToolSchema({ type: ["string", 1] }), false);
  assert.equal(isToolSchema({ anyOf: { type: "string" } }), false);
  assert.equal(isToolSchema(["object"]), false);
});

test("llmToolParameters leaves a boolean property schema as it is", () => {
  const parameters = llmToolParameters({
    type: "object",
    properties: { any: true, email: { type: "string", format: "email" } },
    $schema: "https://json-schema.org/draft/2020-12/schema",
  });
  assert.deepEqual(parameters, {
    type: "object",
    properties: {
      any: true,
      email: { type: "string", description: "Optional. Omit this key when unused; do not pass an empty value." },
    },
  });
});

test("omitEmptyOptionalStrings drops empty optional keys of nested objects", () => {
  const schema = {
    type: "object",
    properties: { filter: { type: "object", properties: { label: { type: "string" }, id: { type: "string" } }, required: ["id"] } },
  };
  assert.deepEqual(
    omitEmptyOptionalStrings({ filter: { label: " ", id: "" } }, schema),
    { filter: { id: "" } },
  );
});

test("offeredParameters offers a union of literals of one type as that type's enum, keeping its description", () => {
  const Side = Type.Union([Type.Literal("debit"), Type.Literal("credit")], { description: "Side." });
  const offered = offeredParameters(
    Type.Object({
      side: Type.Optional(Side),
      sides: Type.Array(Side),
      level: Type.Union([Type.Literal(1), Type.Literal(2)]),
      mixed: Type.Union([Type.Literal("a"), Type.Literal(1)]),
      either: Type.Union([Type.String(), Type.Number()]),
      nested: Type.Object({ side: Side }),
    }),
  );
  const properties = offered.properties ?? {};
  assert.deepEqual(properties.side, { description: "Side.", type: "string", enum: ["debit", "credit"] });
  assert.deepEqual(properties.sides, { type: "array", items: { description: "Side.", type: "string", enum: ["debit", "credit"] } });
  assert.deepEqual(properties.level, { type: "number", enum: [1, 2] });
  assert.deepEqual(properties.mixed, { anyOf: [{ const: "a", type: "string" }, { const: 1, type: "number" }] });
  assert.deepEqual(properties.either, { anyOf: [{ type: "string" }, { type: "number" }] });
  assert.deepEqual(properties.nested, {
    type: "object",
    required: ["side"],
    properties: { side: { description: "Side.", type: "string", enum: ["debit", "credit"] } },
  });
  assert.deepEqual(offered.required, ["sides", "level", "mixed", "either", "nested"]);
  const parameters = Type.Object({ side: Side });
  assert.deepEqual(decodeArguments(parameters, { side: "credit" }, (problem) => new Error(problem)), { side: "credit" });
  assert.throws(() => decodeArguments(parameters, { side: "both" }, (problem) => new Error(problem)), /^Error: \/side: /);
});
