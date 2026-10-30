// The Studio tools for a source-guild agent's standing task: its prior versions and a task draft.

import { Type, type Static } from "@sinclair/typebox";
import { hashArtifactContent } from "../artifacts/store.js";
import { listAgentTaskRevisions } from "../db/agents.js";
import { capBytes } from "../lib/bytes.js";
import { studioTool } from "./arguments.js";
import { STUDIO_DEFAULT_LIMIT, STUDIO_REVISION_LIST_MAX, STUDIO_TOOL_RESULT_MAX_BYTES } from "./constants.js";
import { AgentHistoryArguments, clampLimit, cursorOffset } from "./paging.js";
import { resolveHandle } from "./source-guild.js";
import { wrapEvidence } from "./system.js";
import type { StudioTool } from "./tools.js";

export const studioListTaskRevisions: StudioTool = studioTool({
  name: "studio_list_task_revisions",
  description: "Inspect prior operator task versions.",
  parameters: AgentHistoryArguments,
  async run(deps, call, input: AgentHistoryArguments) {
    const agent = await resolveHandle(deps, call, input.agent_id);
    const limit = clampLimit(input.limit, STUDIO_DEFAULT_LIMIT, STUDIO_REVISION_LIST_MAX);
    const offset = cursorOffset(input.cursor);
    const rows = await listAgentTaskRevisions(deps.db, call.orgId, agent.id);
    const slice = rows.slice(offset, offset + limit);
    return {
      revisions: slice.map((row) => ({
        version: row.version,
        replaced_at: row.replaced_at,
        replaced_by_name: row.replaced_by_name,
        content_hash: hashArtifactContent(row.content),
        content: wrapEvidence({
          source: "task_revision",
          coordinates: { agent_id: agent.id, version: row.version },
          body: capBytes(row.content, STUDIO_TOOL_RESULT_MAX_BYTES)[0],
        }),
      })),
      next_cursor: offset + slice.length < rows.length ? String(offset + slice.length) : null,
    };
  },
});

const CreateTaskDraftArguments = Type.Object({
  agent_id: Type.String({ description: "Source-guild agent id or name from the roster. Required." }),
  proposed_content: Type.String({
    description:
      "Complete standing task in the Task shape: an opening line, then Inputs, Work, Outputs, and Files as headings with bullets. Shared files that must enter every run use ![[display-path]] from studio_find_artifacts / studio_get_artifact. A bare filename does not inline.",
  }),
  rationale: Type.String(),
  evidence_refs: Type.Optional(Type.Array(Type.Unknown())),
  risks: Type.Optional(Type.Array(Type.String())),
});
export type CreateTaskDraftArguments = Static<typeof CreateTaskDraftArguments>;

export const studioCreateTaskDraft: StudioTool = studioTool({
  name: "studio_create_task_draft",
  description:
    "Create or replace a standing task draft for a source-guild agent, named by agent_id; the operator's inspector selection plays no part. Drafts for several agents may be created in one turn. Supply complete proposed content.",
  parameters: CreateTaskDraftArguments,
  async run(deps, call, input: CreateTaskDraftArguments) {
    return deps.drafts.createFromTool(deps.db, call, input);
  },
});
