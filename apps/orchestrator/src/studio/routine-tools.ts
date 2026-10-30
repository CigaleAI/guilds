// The Studio tools for a source-guild agent's routines: listing them and proposing a change to one.

import { Type, type Static } from "@sinclair/typebox";
import { routineRunStats } from "../db/runs.js";
import { listSchedules, listSchedulesForGuild, type AgentScheduleRow } from "../db/schedules.js";
import { scheduleItem } from "../schedules/item.js";
import { studioTool } from "./arguments.js";
import { EditRoutineArguments } from "./edit-arguments.js";
import { STUDIO_DEFAULT_LIMIT } from "./constants.js";
import { routineEditRequest } from "./edits.js";
import { clampLimit, cursorOffset } from "./paging.js";
import { runHeader } from "./run-tools.js";
import { editScope, resolveHandle } from "./source-guild.js";
import { wrapEvidence } from "./system.js";
import type { StudioTool } from "./tools.js";

const ListRoutinesArguments = Type.Object({
  agent_id: Type.Optional(Type.String()),
  paused: Type.Optional(Type.Boolean()),
  cursor: Type.Optional(Type.String()),
  limit: Type.Optional(Type.Integer()),
});
type ListRoutinesArguments = Static<typeof ListRoutinesArguments>;

export const studioListRoutines: StudioTool = studioTool({
  name: "studio_list_routines",
  description: "Inspect schedules and instructions for the source guild, or one agent when agent_id is set.",
  parameters: ListRoutinesArguments,
  async run(deps, call, input: ListRoutinesArguments) {
    const limit = clampLimit(input.limit, STUDIO_DEFAULT_LIMIT, 100);
    const offset = cursorOffset(input.cursor);
    let rows: AgentScheduleRow[];
    if (input.agent_id) {
      const agent = await resolveHandle(deps, call, input.agent_id);
      rows = await listSchedules(deps.db, agent.id);
    } else {
      rows = await listSchedulesForGuild(deps.db, call.sourceGuildId);
    }
    const filtered = rows.filter((row) => input.paused === undefined || row.paused === input.paused);
    const slice = filtered.slice(offset, offset + limit);
    const stats = await routineRunStats(deps.db, slice.map((row) => row.id));
    const routines = [];
    for (const row of slice) {
      const mine = stats.get(row.id);
      routines.push({
        ...scheduleItem(row),
        run_count: mine?.count ?? 0,
        latest_run: mine ? runHeader(mine.latest) : null,
        instruction: wrapEvidence({
          source: "routine",
          coordinates: { schedule_id: row.id },
          body: String(row.instruction ?? ""),
        }),
      });
    }
    return {
      routines,
      next_cursor: offset + slice.length < filtered.length ? String(offset + slice.length) : null,
    };
  },
});

export const studioEditRoutine: StudioTool = studioTool({
  name: "studio_edit_routine",
  description:
    "Propose a change to one routine of a source-guild agent. Nothing is written: the turn pauses and the operator applies or declines. create: a new routine that wakes one agent on a UTC cron or at random times inside a daily window; check studio_list_routines first and change a routine that fits instead. edit: a new timing, description, instruction, or paused state; fields left out stay as they are. delete: its past runs stay; propose pausing it instead when it may be needed again. edit and delete name the routine by schedule_id from studio_list_routines.",
  parameters: EditRoutineArguments,
  async run(deps, call, input: EditRoutineArguments) {
    const agentId = input.action === "create" ? (await resolveHandle(deps, call, input.agent_id)).id : null;
    return routineEditRequest(deps, editScope(call), { args: input, agentId });
  },
});
