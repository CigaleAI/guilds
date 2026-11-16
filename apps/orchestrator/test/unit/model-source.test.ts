import assert from "node:assert/strict";
import { test } from "node:test";
import { modelSourceOf } from "../../src/db/schema/index.js";
import { runToolNaming } from "../../src/generation/prepare.js";

test("an agent with a model runs on that model on a key", () => {
  assert.deepEqual(modelSourceOf({ model: "deepinfra/zai-org/GLM-5.3-Flash" }), {
    kind: "key",
    model: "deepinfra/zai-org/GLM-5.3-Flash",
  });
});

test("an agent without a model runs on a subscription", () => {
  assert.deepEqual(modelSourceOf({ model: null }), { kind: "subscription" });
});

test("a run on a key names each tool by its own name", () => {
  assert.deepEqual(runToolNaming({ model: "deepinfra/zai-org/GLM-5.3-Flash", harness: "claude-code" }), { prefix: "" });
});

test("a subscription agent's run on Claude Code names each tool as Claude Code calls an MCP tool", () => {
  assert.deepEqual(runToolNaming({ model: null, harness: "claude-code" }), { prefix: "mcp__guilds__" });
});

test("a subscription agent's run on Codex names each tool as Codex's model calls an MCP tool", () => {
  assert.deepEqual(runToolNaming({ model: null, harness: "codex" }), { prefix: "mcp__guilds__" });
});

test("a subscription agent's run on a harness that runs no turn names each tool by its own name", () => {
  assert.deepEqual(runToolNaming({ model: null, harness: "cursor" }), { prefix: "" });
  assert.deepEqual(runToolNaming({ model: null, harness: null }), { prefix: "" });
});
