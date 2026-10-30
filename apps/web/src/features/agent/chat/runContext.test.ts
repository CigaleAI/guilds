import assert from "node:assert/strict";
import { test } from "node:test";
import type { Run } from "../../../api/types/runs";
import { defaultAgentConfig } from "../settings/configForm";
import { offeredToolGroups } from "./runContext";

function runOffering(tools: Run["config_snapshot"]["tools"]): Run {
  return {
    id: "r_1",
    agent_id: "a_1",
    status: "active",
    kind: "direct",
    config_snapshot: {
      ...defaultAgentConfig,
      tools,
      mcp: [
        {
          connection_id: "c_1",
          server_id: "s_1",
          slug: "github",
          tools: [{ name: "github_search", remote_name: "search" }],
        },
      ],
      secrets: [],
    },
    errors: [],
    generating: false,
    created_at: "2026-10-01T00:00:00Z",
    updated_at: "2026-10-01T00:00:00Z",
    group_chat_through_seq: null,
  };
}

test("offered tools group under the connected server that serves them, the rest under guilds.run", () => {
  const run = runOffering([
    { type: "function", function: { name: "note_get", description: "Reads a note." } },
    { type: "function", function: { name: "github_search" } },
  ]);
  assert.deepEqual(offeredToolGroups(run), [
    { server: "guilds.run", tools: [{ name: "note_get", description: "Reads a note." }] },
    { server: "github", tools: [{ name: "github_search" }] },
  ]);
});
