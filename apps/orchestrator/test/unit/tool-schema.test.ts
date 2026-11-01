import assert from "node:assert/strict";
import { test } from "node:test";
import { isToolSchema, llmToolParameters, omitEmptyOptionalStrings } from "../../src/lib/tool-schema.js";

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
