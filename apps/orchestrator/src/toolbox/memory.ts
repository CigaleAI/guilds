import { ArtifactError } from "../artifacts/errors.js";
import { validateMemory } from "../memory/index.js";
import { argString, functionSchema } from "./schema.js";
import { identityOutput } from "./output.js";
import { callActor, type Tool, type ToolContext, type ToolInvocation } from "./types.js";

async function publishMemoryFileChanged(ctx: ToolContext): Promise<void> {
  if (ctx.group_chat === null || !ctx.guild_id || !ctx.group_chat.publish) {
    return;
  }
  await ctx.group_chat.publish(ctx.guild_id, "guild.artifacts.changed", {
    scope: "agent",
    path: "memory.md",
    agent_id: ctx.agent_id,
  });
}

async function writeMemoryThroughArtifacts(
  ctx: ToolContext,
  call: ToolInvocation,
  content: string,
  detail: string,
): Promise<string | null> {
  const actor = callActor(ctx.artifact_actor, call);
  if (!ctx.artifacts || !actor) {
    return null;
  }
  const { href } = await ctx.artifacts.writeMemory(actor, ctx.agent_id, { content, detail });
  await publishMemoryFileChanged(ctx);
  return href;
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
  description: "Replace your whole Memory with the full text to keep. Call it only when the next run needs something this run learned.",
  output_filter: identityOutput,
  filter_name: "identity",
  schema: functionSchema(
    "memory_write",
    "Replace your whole Memory with the full text to keep. Call it only when the next run needs something this run learned.",
    {
      content: { type: "string" },
    },
    ["content"],
  ),
  async handler(ctx: ToolContext, call) {
    const content = argString(call.arguments, "content");
    validateMemory(content);
    const detail = ctx.memory_replaced_by || `run ${ctx.run_id} (${ctx.run_kind})`;
    return (
      (await writeMemoryThroughArtifacts(ctx, call, content, detail)) ??
      (await writeMemoryThroughNotes(ctx, content, detail))
    );
  },
};
