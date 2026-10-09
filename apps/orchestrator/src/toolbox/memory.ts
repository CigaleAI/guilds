import { ArtifactError } from "../artifacts/index.js";
import { validateMemory } from "../memory/index.js";
import { argString, functionSchema } from "./schema.js";
import { identityOutput } from "./output.js";
import type { Tool, ToolContext } from "./types.js";

async function publishMemoryFileChanged(ctx: ToolContext): Promise<void> {
  if (ctx.group_chat === null || !ctx.guild_id || !ctx.group_chat.publish) {
    return;
  }
  await ctx.group_chat.publish(ctx.guild_id, "guild.files.changed", {
    scope: "agent",
    path: "memory.md",
    agent_id: ctx.agent_id,
  });
}

async function writeMemoryThroughArtifacts(
  ctx: ToolContext,
  content: string,
  detail: string,
): Promise<string | null> {
  if (!ctx.artifacts || !ctx.artifact_actor) {
    return null;
  }
  const row = await ctx.artifacts.writeMemory(ctx.artifact_actor, ctx.agent_id, content, detail);
  await publishMemoryFileChanged(ctx);
  return String(ctx.artifacts.view(row).display_path);
}

async function writeMemoryThroughNotes(
  ctx: ToolContext,
  content: string,
  detail: string,
): Promise<string> {
  if (!ctx.notes) {
    throw new ArtifactError("artifact store is not available", 500);
  }
  return ctx.notes.writeMemory(ctx.org_slug, ctx.guild_name, ctx.agent_name, content, {
    source: ctx.run_id,
    replacedBy: detail,
  });
}

export const memoryWrite: Tool = {
  name: "memory_write",
  description: "Replace standing memory with the full text you want to remember.",
  output_filter: identityOutput,
  filter_name: "identity",
  schema: functionSchema(
    "memory_write",
    "Replace standing memory with the full text you want to remember.",
    {
      content: { type: "string" },
    },
    ["content"],
  ),
  async handler(ctx: ToolContext, args) {
    const content = argString(args, "content");
    validateMemory(content);
    const detail = ctx.memory_replaced_by || `run ${ctx.run_id} (${ctx.run_kind})`;
    return (
      (await writeMemoryThroughArtifacts(ctx, content, detail)) ??
      (await writeMemoryThroughNotes(ctx, content, detail))
    );
  },
};
