import { ArtifactError } from "../artifacts/errors.js";
import { validateMemory } from "../memory/index.js";
import { argString, functionSchema } from "./schema.js";
import { identityOutput } from "./output.js";
import type { ToolServices } from "./services.js";
import { callActor, type Tool, type ToolInvocation, type ToolRun } from "./types.js";

async function publishMemoryFileChanged(services: ToolServices, run: ToolRun): Promise<void> {
  if (services.group_chat === null || !run.guild_id || !services.group_chat.publish) {
    return;
  }
  await services.group_chat.publish(run.guild_id, "guild.artifacts.changed", {
    scope: "agent",
    path: "memory.md",
    agent_id: run.agent_id,
  });
}

/** What a Memory write in `run` names as what replaced the previous Memory. */
function replacedBy(run: ToolRun): string {
  return run.memory_replaced_by || `run ${run.run_id} (${run.run_kind})`;
}

async function writeMemoryThroughArtifacts(
  services: ToolServices,
  run: ToolRun,
  call: ToolInvocation,
  content: string,
): Promise<string | null> {
  const actor = callActor(run.artifact_actor, call);
  if (!services.artifacts || !actor) {
    return null;
  }
  const { href } = await services.artifacts.writeMemory(actor, run.agent_id, { content, detail: replacedBy(run) });
  await publishMemoryFileChanged(services, run);
  return href;
}

async function writeMemoryThroughNotes(services: ToolServices, run: ToolRun, content: string): Promise<string> {
  if (!services.notes) {
    throw new ArtifactError("artifact store is not available", 500);
  }
  return services.notes.writeMemory(run.org_slug, run.guild_name, run.agent_name, content, {
    source: run.run_id,
    replacedBy: replacedBy(run),
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
  async handler(services, run, _hooks, call) {
    const content = argString(call.arguments, "content");
    validateMemory(content);
    return (
      (await writeMemoryThroughArtifacts(services, run, call, content)) ??
      (await writeMemoryThroughNotes(services, run, content))
    );
  },
};
