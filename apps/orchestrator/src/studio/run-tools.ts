// The Studio tools that read a source-guild agent's runs: run headers and one run's messages.

import { Type, type Static } from "@sinclair/typebox";
import { getAgent } from "../db/agents.js";
import { getRun, listMessages, listRunHeaders, type MessageRow, type RunHeaderRow } from "../db/runs.js";
import { iso } from "../db/views.js";
import { capBytes } from "../lib/bytes.js";
import { studioTool } from "./arguments.js";
import { STUDIO_DEFAULT_LIMIT, STUDIO_RUN_LIST_MAX, STUDIO_TOOL_RESULT_MAX_BYTES } from "./constants.js";
import { StudioUnprocessableError } from "./errors.js";
import { clampLimit, cursorOffset } from "./paging.js";
import { resolveHandle } from "./source-guild.js";
import { wrapEvidence } from "./system.js";
import type { StudioTool } from "./tools.js";

// The run facts a listing carries: enough to pick a run without its transcript.
export function runHeader(row: RunHeaderRow): Record<string, unknown> {
  return {
    id: row.id,
    kind: row.kind,
    status: row.status,
    task_prompt_hash: row.task_prompt_hash,
    system_prompt_hash: row.system_prompt_hash,
    schedule_id: row.schedule_id,
    instruction_hash: row.metadata.instruction_hash ?? null,
    created_at: iso(row.created_at),
    updated_at: iso(row.updated_at),
    error_count: row.errors.length,
  };
}

const ListRunsArguments = Type.Object({
  agent_id: Type.Optional(Type.String()),
  kind: Type.Optional(Type.String()),
  status: Type.Optional(Type.String()),
  error_only: Type.Optional(Type.Boolean()),
  task_prompt_hash: Type.Optional(Type.String()),
  schedule_id: Type.Optional(Type.String({ description: "Only runs woken by this routine." })),
  cursor: Type.Optional(Type.String()),
  limit: Type.Optional(Type.Integer()),
});
type ListRunsArguments = Static<typeof ListRunsArguments>;

export const studioListRuns: StudioTool = studioTool({
  name: "studio_list_runs",
  description:
    "Find behavioral evidence without loading transcripts. kind is direct, group, or schedule; schedule_id lists the runs one routine produced.",
  parameters: ListRunsArguments,
  async run(deps, call, input: ListRunsArguments) {
    const agent = await resolveHandle(deps, call, input.agent_id);
    const limit = clampLimit(input.limit, STUDIO_DEFAULT_LIMIT, STUDIO_RUN_LIST_MAX);
    const offset = cursorOffset(input.cursor);
    // One row past the page says whether another page follows.
    const rows = await listRunHeaders(deps.db, agent.id, {
      kind: input.kind,
      status: input.status,
      taskPromptHash: input.task_prompt_hash,
      scheduleId: input.schedule_id,
      errorOnly: input.error_only === true,
      limit: limit + 1,
      offset,
    });
    const slice = rows.slice(0, limit);
    return {
      runs: slice.map((row) => ({
        ...runHeader(row),
        errors: row.errors,
        task_source: row.metadata.task_source ?? null,
      })),
      next_cursor: rows.length > limit ? String(offset + limit) : null,
    };
  },
});

/** The assistant messages of `messages` that called `toolName`, and those calls' results. */
function callsOfTool(messages: MessageRow[], toolName: string): MessageRow[] {
  const callIds = new Set<string>();
  return messages.filter(({ payload }) => {
    if (payload.role === "assistant") {
      const mine = (payload.tool_calls ?? []).filter((call) => call.function.name === toolName);
      for (const call of mine) callIds.add(call.id);
      return mine.length > 0;
    }
    return payload.role === "tool" && callIds.has(payload.tool_call_id);
  });
}

const GetRunArguments = Type.Object({
  run_id: Type.String(),
  seq_start: Type.Optional(Type.Integer()),
  seq_end: Type.Optional(Type.Integer()),
  tool_name: Type.Optional(Type.String({ description: "Only the turns that called this tool, and their results." })),
});
type GetRunArguments = Static<typeof GetRunArguments>;

export const studioGetRun: StudioTool = studioTool({
  name: "studio_get_run",
  description:
    "Read exact historical evidence for a source-guild run. seq_start and seq_end bound the message window. tool_name keeps only the assistant turns that requested that tool and their tool results, for example memory_write or note_write.",
  parameters: GetRunArguments,
  async run(deps, call, input: GetRunArguments) {
    const runId = input.run_id;
    const run = await getRun(deps.db, runId);
    if (!run) {
      throw new StudioUnprocessableError("run not found");
    }
    const agent = await getAgent(deps.db, run.agent_id);
    if (!agent || agent.guild_id !== call.sourceGuildId) {
      throw new StudioUnprocessableError("run is not in the source guild");
    }
    const seqStart = input.seq_start ?? 0;
    const seqEnd = input.seq_end ?? 10_000;
    const toolName = input.tool_name;
    let messages = (await listMessages(deps.db, runId)).filter((row) => row.seq >= seqStart && row.seq <= seqEnd);
    if (toolName) {
      messages = callsOfTool(messages, toolName);
    }
    const capped = messages.map((row) => {
      const [cut, truncated] = capBytes(row.payload.content, STUDIO_TOOL_RESULT_MAX_BYTES);
      return { seq: row.seq, payload: { ...row.payload, content: cut }, metadata: row.metadata, truncated };
    });
    return {
      run: {
        id: run.id,
        agent_id: run.agent_id,
        kind: run.kind,
        status: run.status,
        task_prompt_hash: run.task_prompt_hash,
        schedule_id: run.schedule_id,
        metadata: run.metadata,
      },
      ...(toolName ? { tool_name: toolName, matched: capped.length } : {}),
      messages: capped.map((row) => ({
        ...row,
        payload: {
          ...row.payload,
          content: wrapEvidence({
            source: "run_message",
            coordinates: { run_id: runId, seq: row.seq },
            body: row.payload.content,
          }),
        },
      })),
    };
  },
});
