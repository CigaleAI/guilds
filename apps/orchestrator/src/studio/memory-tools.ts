// The Studio tools for a source-guild agent's Memory: its versions, one version with its diff, and a
// proposed replacement.

import { Type, type Static } from "@sinclair/typebox";
import { operatorActor } from "../artifacts/actors.js";
import { memoryDiffText, memoryTimeline, type MemoryTimelineEntry } from "../artifacts/memory.js";
import type { AgentRow } from "../db/agents.js";
import { capBytes } from "../lib/bytes.js";
import { studioTool } from "./arguments.js";
import { EditMemoryArguments } from "./edit-arguments.js";
import { STUDIO_DEFAULT_LIMIT, STUDIO_REVISION_LIST_MAX, STUDIO_TOOL_RESULT_MAX_BYTES } from "./constants.js";
import { editRequest, loadMemoryBase } from "./edits.js";
import { StudioUnprocessableError } from "./errors.js";
import { AgentHistoryArguments, clampLimit, cursorOffset, sliceStudioBytes } from "./paging.js";
import { editScope, resolveHandle } from "./source-guild.js";
import { wrapEvidence } from "./system.js";
import type { StudioTool, StudioToolCall, StudioToolDeps } from "./tools.js";

async function memoryTimelineFor(
  deps: StudioToolDeps,
  call: StudioToolCall,
  agent: Pick<AgentRow, "id">,
): Promise<MemoryTimelineEntry[]> {
  const actor = operatorActor({
    orgId: call.orgId,
    actorId: call.user.id,
    actorName: call.user.name ?? "operator",
    guildId: call.sourceGuildId,
    agentId: agent.id,
  });
  return (await memoryTimeline(deps.artifacts, actor, agent.id)).entries;
}

function timelineHeader(entry: MemoryTimelineEntry): Record<string, unknown> {
  return {
    version_index: entry.index,
    revision_id: entry.revision_id,
    live: entry.revision_id === null,
    archive_display_path: entry.archive_display_path,
    written_at: entry.written_at,
    actor: entry.actor,
    run_id: entry.run_id,
    stats: entry.stats,
    content_hash: entry.content_hash,
  };
}

export const studioListMemoryRevisions: StudioTool = studioTool({
  name: "studio_list_memory_revisions",
  description:
    "List the versions an agent's Memory has held, newest first: who wrote each version (a run id, a user, or the agent), when, and line counts. Content is not included; read one version with studio_get_memory_version.",
  parameters: AgentHistoryArguments,
  async run(deps, call, input: AgentHistoryArguments) {
    const agent = await resolveHandle(deps, call, input.agent_id);
    const limit = clampLimit(input.limit, STUDIO_DEFAULT_LIMIT, STUDIO_REVISION_LIST_MAX);
    const offset = cursorOffset(input.cursor);
    const entries = await memoryTimelineFor(deps, call, agent);
    const slice = entries.slice(offset, offset + limit);
    return {
      agent_id: agent.id,
      versions: slice.map(timelineHeader),
      next_cursor: offset + slice.length < entries.length ? String(offset + slice.length) : null,
    };
  },
});

const GetMemoryVersionArguments = Type.Object({
  agent_id: Type.String({ description: "Source-guild agent id or name. Required." }),
  revision_id: Type.Optional(
    Type.String({ description: "Revision id of the version to read. Omit for the live version." }),
  ),
  version_index: Type.Optional(Type.Integer({ description: "Version index from studio_list_memory_revisions." })),
  cursor: Type.Optional(Type.String()),
});
type GetMemoryVersionArguments = Static<typeof GetMemoryVersionArguments>;

export const studioGetMemoryVersion: StudioTool = studioTool({
  name: "studio_get_memory_version",
  description:
    "Read one version of an agent's Memory by revision_id or version_index from studio_list_memory_revisions (omit both for the live version), with the line diff against the previous version.",
  parameters: GetMemoryVersionArguments,
  async run(deps, call, input: GetMemoryVersionArguments) {
    const agent = await resolveHandle(deps, call, input.agent_id);
    const entries = await memoryTimelineFor(deps, call, agent);
    const { revision_id: revisionId, version_index: index } = input;
    const entry = revisionId
      ? entries.find((item) => item.revision_id === revisionId)
      : index !== undefined
        ? entries.find((item) => item.index === index)
        : entries.find((item) => item.revision_id === null);
    if (!entry) {
      throw new StudioUnprocessableError("memory version not found");
    }
    const sliced = sliceStudioBytes(entry.content, input.cursor);
    const diff = entry.previous_content === null ? "" : memoryDiffText(entry.previous_content, entry.content);
    return {
      agent_id: agent.id,
      ...timelineHeader(entry),
      content: wrapEvidence({
        source: "memory_version",
        coordinates: { agent_id: agent.id, revision_id: entry.revision_id, version_index: entry.index },
        body: sliced.text,
      }),
      ...(sliced.next_cursor ? { next_cursor: sliced.next_cursor } : {}),
      ...(sliced.truncated ? { truncated: true } : {}),
      diff_from_previous: diff
        ? wrapEvidence({
            source: "memory_version_diff",
            coordinates: { agent_id: agent.id, version_index: entry.index },
            body: capBytes(diff, STUDIO_TOOL_RESULT_MAX_BYTES)[0],
          })
        : null,
    };
  },
});

export const studioEditMemory: StudioTool = studioTool({
  name: "studio_edit_memory",
  description:
    "Propose a complete replacement of one source-guild agent's Memory. Nothing is written: the turn pauses and the operator applies or declines. Read the live Memory first and pass its version as base_version.",
  parameters: EditMemoryArguments,
  async run(deps, call, input: EditMemoryArguments) {
    const agent = await resolveHandle(deps, call, input.agent_id);
    const base = await loadMemoryBase(deps, editScope(call), agent);
    return editRequest(base, input, input.base_version);
  },
});
