// The Studio tools for a source-guild agent's routines: listing them and proposing a change to one.

import { Type, type Static } from "@sinclair/typebox";
import { routineRunStats } from "../db/runs.js";
import { listSchedules, listSchedulesForGuild, type AgentScheduleRow } from "../db/schedules.js";
import { scheduleItem } from "../schedules/item.js";
import { editActionOf } from "./actions.js";
import { decodeStudioArguments, studioFunctionSchema } from "./arguments.js";
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

export const studioListRoutines: StudioTool = {
  name: "studio_list_routines",
  schema: studioFunctionSchema(
    "studio_list_routines",
    "Inspect schedules and instructions for the source guild, or one agent when agent_id is set.",
    ListRoutinesArguments,
  ),
  async handler(deps, call, args) {
    const input: ListRoutinesArguments = decodeStudioArguments(ListRoutinesArguments, args);
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
};

const EditRoutineArguments = Type.Object({
  action: Type.String({ enum: ["create", "edit", "delete"], description: "Required." }),
  agent_id: Type.Optional(Type.String({ description: "create: source-guild agent id or name." })),
  schedule_id: Type.Optional(Type.String({ description: "edit and delete: the routine's id from studio_list_routines." })),
  cron: Type.Optional(
    Type.String({
      description:
        "5-field UTC expression (minute hour day month weekday), for example '0 9 * * 1'; wake-ups at least 5 minutes apart. Pass cron or window, not both.",
    }),
  ),
  window: Type.Optional(
    Type.Object(
      {
        timezone: Type.String({ description: "IANA name, for example Europe/Paris." }),
        start: Type.String({ description: "HH:MM local time." }),
        end: Type.String({ description: "HH:MM local time; earlier than start spans midnight." }),
        max_wakes: Type.Integer({ description: "Most wake-ups per window; gaps are at least 5 minutes." }),
      },
      {
        description: "Random wake-ups inside a daily local-time window. Pass cron or window, not both.",
        additionalProperties: false,
      },
    ),
  ),
  description: Type.Optional(
    Type.String({ description: "One-line label shown in the Routine tab, at most 400 characters." }),
  ),
  instruction: Type.Optional(
    Type.String({
      description: "Short markdown the agent receives on each wake-up, at most 2000 characters: what this wake-up is for, not the agent's whole Task.",
    }),
  ),
  paused: Type.Optional(
    Type.Boolean({ description: "create: true creates it paused. edit: true pauses it; false resumes it." }),
  ),
  reason: Type.String({ description: "Why this change, one or two sentences, citing evidence. Required." }),
});
type EditRoutineArguments = Static<typeof EditRoutineArguments>;

export const studioEditRoutine: StudioTool = {
  name: "studio_edit_routine",
  schema: studioFunctionSchema(
    "studio_edit_routine",
    "Propose a change to one routine of a source-guild agent. Nothing is written: the turn pauses and the operator applies or declines. create: a new routine that wakes one agent on a UTC cron or at random times inside a daily window; check studio_list_routines first and change a routine that fits instead. edit: a new timing, description, instruction, or paused state; fields left out stay as they are. delete: its past runs stay; propose pausing it instead when it may be needed again. edit and delete name the routine by schedule_id from studio_list_routines.",
    EditRoutineArguments,
  ),
  async handler(deps, call, args) {
    const input: EditRoutineArguments = decodeStudioArguments(EditRoutineArguments, args);
    const agentId = editActionOf(input) === "create" ? (await resolveHandle(deps, call, input.agent_id)).id : null;
    return routineEditRequest(deps, editScope(call), { args: input, agentId });
  },
};
