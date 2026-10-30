// The Studio tools that read the prompt a source-guild agent runs with: the shared Guidelines and the
// agent's task, memory, state, config, and effective prompt.

import { Type, type Static } from "@sinclair/typebox";
import { agentTask } from "../artifacts/task.js";
import { composeAgentSystemPrompt, hydrateStanding, promptHash, schemasOffer } from "../prompts/index.js";
import { studioChoice, studioTool } from "./arguments.js";
import { STUDIO_DEFAULT_CONTEXT_SECTIONS, STUDIO_TOTAL_RETURNED_BYTES } from "./constants.js";
import { sliceStudioBytes, truncatePayload } from "./paging.js";
import { previewCurrentState, projectOfferedToolSchemas } from "./preview.js";
import { resolveHandle } from "./source-guild.js";
import { wrapEvidence } from "./system.js";
import type { StudioTool } from "./tools.js";

function fitStudioPayload(payload: Record<string, unknown>): Record<string, unknown> {
  if (Buffer.from(JSON.stringify(payload), "utf8").length <= STUDIO_TOTAL_RETURNED_BYTES) {
    return payload;
  }
  const omitted: string[] = [];
  const next = { ...payload };
  for (const key of ["effective_prompt", "state", "memory", "config", "effective_prompt_headers"]) {
    if (!(key in next)) continue;
    delete next[key];
    omitted.push(key);
    if (Buffer.from(JSON.stringify(next), "utf8").length <= STUDIO_TOTAL_RETURNED_BYTES) {
      return {
        ...next,
        omitted_sections: omitted,
        hint: "request omitted sections in a separate studio_get_agent_context call",
      };
    }
  }
  return truncatePayload(next);
}

export const studioGetGuidelines: StudioTool = studioTool({
  name: "studio_get_guidelines",
  description: "Inspect the shared read-only Guidelines source.",
  parameters: Type.Object({}),
  async run(deps) {
    const standing = hydrateStanding({
      systemPath: deps.notesSystemPath,
      agentName: "studio",
      agentId: "studio",
    });
    return {
      source: "apps/orchestrator/src/prompts/system.md",
      ownership: "shared",
      editable: false,
      content_hash: promptHash(standing),
      content: wrapEvidence({ source: "guidelines", body: standing }),
    };
  },
});

const CONTEXT_SECTIONS = ["task", "memory", "state", "config", "effective_prompt", "effective_prompt_headers"] as const;
type ContextSection = (typeof CONTEXT_SECTIONS)[number];

const GetAgentContextArguments = Type.Object({
  agent_id: Type.String({ description: "Source-guild agent id or name. Required." }),
  sections: Type.Optional(
    Type.Array(studioChoice(CONTEXT_SECTIONS), {
      description: "Any of task, memory, state, config, effective_prompt, effective_prompt_headers. Defaults to task.",
    }),
  ),
  cursor: Type.Optional(Type.String()),
});
type GetAgentContextArguments = Static<typeof GetAgentContextArguments>;

export const studioGetAgentContext: StudioTool = studioTool({
  name: "studio_get_agent_context",
  description:
    "Inspect current prompt sources for one source-guild agent. The first 500 words of each standing task are already in the Studio system prompt. Use this tool for the remainder of a truncated task, the full task, memory, state, config, or effective_prompt (the exact opening system message the next run would receive, with task embeds inlined). Pass agent_id or name.",
  parameters: GetAgentContextArguments,
  async run(deps, call, input: GetAgentContextArguments) {
    const agent = await resolveHandle(deps, call, input.agent_id);
    const want = new Set<ContextSection>(input.sections ?? STUDIO_DEFAULT_CONTEXT_SECTIONS);
    const cursor = input.cursor;
    const task = await agentTask(deps.artifacts, agent);
    const memory = task.memory;
    // state and effective_prompt read the same projection; take it once.
    let statePreview: ReturnType<typeof previewCurrentState> | null = null;
    const currentState = () => (statePreview ??= previewCurrentState(deps.preview, agent));
    const result: Record<string, unknown> = {
      agent_id: agent.id,
      name: agent.name,
      focus: agent.focus,
    };
    if (want.has("task")) {
      const sliced = sliceStudioBytes(task.text, cursor);
      result.task = {
        display_path: task.displayPath,
        version: task.version,
        content_hash: task.hash,
        has_embeds: task.hasEmbeds,
        ownership: "operator-owned",
        editable: true,
        content: wrapEvidence({ source: "task", coordinates: { version: task.version }, body: sliced.text }),
        ...(sliced.next_cursor ? { next_cursor: sliced.next_cursor } : {}),
        ...(sliced.truncated ? { truncated: true } : {}),
      };
    }
    if (want.has("memory") && memory) {
      const sliced = sliceStudioBytes(memory.content_text ?? "", want.has("task") ? undefined : cursor);
      result.memory = {
        version: memory.version,
        content_hash: memory.content_hash,
        ownership: "agent-owned",
        editable: true,
        content: wrapEvidence({ source: "memory", body: sliced.text }),
        ...(sliced.next_cursor ? { next_cursor: sliced.next_cursor } : {}),
        ...(sliced.truncated ? { truncated: true } : {}),
      };
    }
    if (want.has("state")) {
      const preview = await currentState();
      const sliced = sliceStudioBytes(JSON.stringify(preview.state, null, 2), want.has("task") || want.has("memory") ? undefined : cursor);
      result.state = {
        ownership: "derived",
        editable: false,
        projected_at: preview.projected_at,
        content: wrapEvidence({ source: "state", body: sliced.text }),
        ...(sliced.next_cursor ? { next_cursor: sliced.next_cursor } : {}),
        ...(sliced.truncated ? { truncated: true } : {}),
      };
    }
    if (want.has("config")) {
      result.config = agent.config;
    }
    if (want.has("effective_prompt")) {
      const standing = hydrateStanding({
        systemPath: deps.notesSystemPath,
        agentName: agent.name,
        agentId: agent.id,
      });
      const effectiveTask = task.expanded.ok ? task.expanded.text : task.text;
      const preview = await currentState();
      const tools = await projectOfferedToolSchemas(deps.preview, agent);
      const memoryEnabled = agent.config.memory;
      const composed = composeAgentSystemPrompt(
        standing,
        effectiveTask,
        preview.state,
        task.memoryText,
        memoryEnabled,
        memoryEnabled && schemasOffer(tools.schemas, "memory_write"),
      );
      const sliced = sliceStudioBytes(composed, want.size === 1 ? cursor : undefined);
      result.effective_prompt = {
        ownership: "derived",
        editable: false,
        hash: promptHash(composed),
        task_hash: promptHash(effectiveTask),
        memory_hash: promptHash(task.memoryText),
        projected_at: preview.projected_at,
        ...(task.expanded.ok ? {} : { embed_warning: task.expanded.error }),
        content: wrapEvidence({ source: "effective_prompt", coordinates: { agent_id: agent.id }, body: sliced.text }),
        ...(sliced.next_cursor ? { next_cursor: sliced.next_cursor } : {}),
        ...(sliced.truncated ? { truncated: true } : {}),
      };
    }
    if (want.has("effective_prompt_headers")) {
      result.effective_prompt_headers = [
        { section: "guidelines", ownership: "shared", editable: false },
        { section: "task", ownership: "operator-owned", editable: true, version: task.version, content_hash: task.hash },
        { section: "state", ownership: "derived", editable: false },
        { section: "memory", ownership: "agent-owned", editable: true, version: memory?.version },
      ];
    }
    return fitStudioPayload(result);
  },
});
