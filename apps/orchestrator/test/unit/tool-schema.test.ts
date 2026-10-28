import assert from "node:assert/strict";
import { test } from "node:test";
import { omitEmptyOptionalStrings } from "../../src/lib/tool-schema.js";

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
