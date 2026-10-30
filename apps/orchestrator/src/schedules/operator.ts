import type { AgentRow } from "../db/agents.js";
import type { ScheduleRow } from "../db/schedules.js";
import type { ChangeActor } from "../lib/change-actor.js";
import type { RoutineDraft, ScheduleChanges, Schedules } from "./service.js";

/** How a routine changed: created, edited, paused, resumed, or deleted. */
export type RoutineChangeAction = "create" | "edit" | "pause" | "resume" | "delete";

/** A routine that changed, for the guild's listeners: the agent it wakes, how it changed, and its id. */
export type RoutineChange = { agentId: string; action: RoutineChangeAction; scheduleId: string };

/** What an operator's routine writes run with: the routines, and the announcement of each change. */
export type RoutineWriteDeps = {
  schedules: Schedules;
  /** Tells the agent's guild that a routine changed; absent on a box with no guild stream. */
  publishRoutinesChanged?: (guildId: string, change: RoutineChange) => Promise<void>;
};

/** The agent whose routines an operator writes: its id, and the guild a change is announced to. */
export type RoutineAgent = Pick<AgentRow, "id" | "guild_id">;

/** One routine of an agent. */
export type AgentRoutine = { agent: RoutineAgent; scheduleId: string };

/** How a routine change reads to the guild: a pause or resume alone, or an edit. */
function routineAction(changes: ScheduleChanges): RoutineChangeAction {
  const fields = Object.keys(changes).filter((key) => key !== "paused");
  if (fields.length || changes.paused === undefined) {
    return "edit";
  }
  return changes.paused ? "pause" : "resume";
}

/** Creates a routine for the agent as `actor`, and announces it to the agent's guild. */
export async function createRoutine(
  deps: RoutineWriteDeps,
  actor: ChangeActor,
  agent: RoutineAgent,
  draft: RoutineDraft,
): Promise<ScheduleRow> {
  const row = await deps.schedules.create(actor, agent.id, draft);
  await deps.publishRoutinesChanged?.(agent.guild_id, { agentId: agent.id, action: "create", scheduleId: row.id });
  return row;
}

/** Changes the routine as `actor`, and announces it to the agent's guild as an edit, a pause, or a resume. */
export async function updateRoutine(
  deps: RoutineWriteDeps,
  actor: ChangeActor,
  routine: AgentRoutine,
  changes: ScheduleChanges,
): Promise<ScheduleRow> {
  const { agent } = routine;
  const row = await deps.schedules.update(actor, agent.id, routine.scheduleId, changes);
  await deps.publishRoutinesChanged?.(agent.guild_id, {
    agentId: agent.id,
    action: routineAction(changes),
    scheduleId: row.id,
  });
  return row;
}

/** Deletes the routine as `actor`, and announces it to the agent's guild. */
export async function deleteRoutine(
  deps: RoutineWriteDeps,
  actor: ChangeActor,
  routine: AgentRoutine,
): Promise<void> {
  const { agent, scheduleId } = routine;
  await deps.schedules.delete(actor, agent.id, scheduleId);
  await deps.publishRoutinesChanged?.(agent.guild_id, { agentId: agent.id, action: "delete", scheduleId });
}
