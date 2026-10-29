import assert from "node:assert/strict";
import { test } from "node:test";
import { agentActor } from "../../src/artifacts/actors.js";
import { ArtifactError } from "../../src/artifacts/errors.js";
import { MemoryError } from "../../src/memory/index.js";
import { memoryWrite } from "../../src/toolbox/memory.js";
import { createToolContext } from "../../src/toolbox/types.js";
import { noteRowAt } from "../helpers/artifacts.js";
import { toolInvocation } from "../helpers/toolbox.js";

const actor = agentActor({
  orgId: "org_1",
  guildId: "g_1",
  agentId: "a_1",
  agentName: "researcher",
  runId: "r_1",
});

test("memory_write stores through artifacts and publishes a file change", async () => {
  const published: unknown[] = [];
  const ctx = createToolContext({
    run_id: "r_1",
    agent_id: "a_1",
    guild_id: "g_1",
    sandbox: {} as never,
    secrets: {},
    artifacts: {
      async writeMemory(_actor: unknown, agentId: string, write: { content: string }) {
        const href = `org/org_1/agents/${agentId}/memory.md`;
        return { href, row: noteRowAt(href, write.content, { kind: "memory" }) };
      },
    } as never,
    artifact_actor: actor,
    group_chat: {
      publish: async (_guild: string, event: string, payload: unknown) => {
        published.push([event, payload]);
      },
    } as never,
  });
  const result = await memoryWrite.handler(ctx, toolInvocation("memory_write", { content: "keep this" }));
  assert.equal(result, "org/org_1/agents/a_1/memory.md");
  assert.deepEqual(published, [
    ["guild.artifacts.changed", { scope: "agent", path: "memory.md", agent_id: "a_1" }],
  ]);
});

test("memory_write falls back to notes when artifacts are absent", async () => {
  const ctx = createToolContext({
    run_id: "r_1",
    agent_id: "a_1",
    guild_id: "g_1",
    sandbox: {} as never,
    secrets: {},
    org_slug: "acme",
    guild_name: "research",
    agent_name: "researcher",
    notes: {
      async writeMemory(
        org: string,
        guild: string,
        agent: string,
        content: string,
        options: { source: string; replacedBy: string },
      ) {
        return `${org}/${guild}/${agent}:${content}:${options.source}:${options.replacedBy}`;
      },
    } as never,
  });
  const result = await memoryWrite.handler(ctx, toolInvocation("memory_write", { content: "keep this" }));
  assert.equal(result, "acme/research/researcher:keep this:r_1:run r_1 (direct)");
});

test("memory_write uses memory_replaced_by when the run already named the writer", async () => {
  const ctx = createToolContext({
    run_id: "r_1",
    agent_id: "a_1",
    guild_id: "g_1",
    sandbox: {} as never,
    secrets: {},
    org_slug: "acme",
    guild_name: "research",
    agent_name: "researcher",
    memory_replaced_by: "user manu (Files pane)",
    notes: {
      async writeMemory(
        _org: string,
        _guild: string,
        _agent: string,
        _content: string,
        options: { replacedBy: string },
      ) {
        return options.replacedBy;
      },
    } as never,
  });
  assert.equal(await memoryWrite.handler(ctx, toolInvocation("memory_write", { content: "keep" })), "user manu (Files pane)");
});

test("memory_write fails when neither artifacts nor notes are available", async () => {
  const ctx = createToolContext({
    run_id: "r_1",
    agent_id: "a_1",
    guild_id: "g_1",
    sandbox: {} as never,
    secrets: {},
  });
  await assert.rejects(
    () => memoryWrite.handler(ctx, toolInvocation("memory_write", { content: "keep" })),
    (error: Error) => error instanceof ArtifactError && error.message.includes("artifact store"),
  );
});

test("memory_write rejects a body over the cap before writing", async () => {
  const ctx = createToolContext({
    run_id: "r_1",
    agent_id: "a_1",
    guild_id: "g_1",
    sandbox: {} as never,
    secrets: {},
  });
  await assert.rejects(() => memoryWrite.handler(ctx, toolInvocation("memory_write", { content: "x".repeat(12_001) })), MemoryError);
});
