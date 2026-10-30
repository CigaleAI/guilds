import { createHash } from "node:crypto";
import type { ScheduleDefinition, ScheduleTiming } from "../db/schedules.js";
import { ScheduleError } from "../schedules/cron.js";
import { timingText } from "../schedules/item.js";
import type { RoutineChange } from "../schedules/operator.js";
import { changedFields, scheduleChanges, type ScheduleChanges } from "../schedules/service.js";
import { argString } from "../toolbox/schema.js";
import type { EditAction } from "./actions.js";
import type { RoutineTarget } from "./edit-request.js";
import type { EditDeps, EditScope } from "./edits.js";
import { editActor } from "./actor.js";
import { StudioUnprocessableError } from "./errors.js";
import { getGuild } from "../db/guilds.js";
import { listAgents } from "../db/agents.js";
import { listSchedulesForGuild } from "../db/schedules.js";

// Routines the coach proposes to create, change, or delete for the source
// guild's live agents. Like every Studio edit, a proposal writes nothing
// until the operator applies it.

export const STUDIO_ROUTINE_TOOL = "studio_edit_routine";
export type RoutineAction = EditAction;

export function isRoutineTool(name: string): boolean {
  return name === STUDIO_ROUTINE_TOOL;
}

/** What a routine is: when it wakes, its label, what it tells the agent, and whether it fires. */
type Definition = {
  timing: ScheduleTiming;
  description: string;
  instruction: string;
  paused: boolean;
};

type Member = { id: string; name: string };

type Routine = { id: string; agent: Member; definition: Definition };

type RoutineContext = {
  deps: EditDeps;
  scope: EditScope;
  guildName: string;
  routinesEnabled: boolean;
  members: Member[];
};

export type RoutinePlan =
  | { action: "create"; agentId: string; definition: Definition }
  | { action: "edit"; agentId: string; scheduleId: string; changes: ScheduleChanges }
  | { action: "delete"; agentId: string; scheduleId: string };

/**
 * A routine proposal checked against the live guild: the routine before and
 * after, rendered as text, what applying does, the hashes that bind it, and
 * the write.
 */
export type RoutineReview = {
  action: RoutineAction;
  title: string;
  target: RoutineTarget;
  baseHash: string;
  proposedHash: string;
  live: string;
  proposed: string;
  effects: string[];
  plan: RoutinePlan;
};

/** The tool call under review, and the agent a create names: its handle resolved, or its request's record. */
export type RoutineCall = { args: Record<string, unknown>; agentId: string | null };


function hashOf(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
}

function scheduleFailure(error: unknown): never {
  if (error instanceof ScheduleError) {
    throw new StudioUnprocessableError(error.message);
  }
  throw error;
}

function valid<T>(read: () => T): T {
  try {
    return read();
  } catch (error) {
    scheduleFailure(error);
  }
}

async function routineContext(deps: EditDeps, scope: EditScope): Promise<RoutineContext> {
  const guild = await getGuild(deps.db, scope.sourceGuildId);
  const agents = await listAgents(deps.db, scope.sourceGuildId);
  return {
    deps,
    scope,
    guildName: String(guild?.name ?? "this guild"),
    routinesEnabled: guild?.routines_enabled !== false,
    members: agents.map((row) => ({ id: String(row.id), name: String(row.name) })),
  };
}

function requireMember(rc: RoutineContext, agentId: string | null): Member {
  const member = rc.members.find((row) => row.id === agentId);
  if (!member) {
    throw new StudioUnprocessableError("agent_id must name a live agent of the source guild");
  }
  return member;
}

async function loadRoutine(rc: RoutineContext, scheduleId: string): Promise<Routine> {
  const rows = await listSchedulesForGuild(rc.deps.db, rc.scope.sourceGuildId);
  const row = rows.find((item) => String(item.id) === scheduleId);
  if (!row) {
    throw new StudioUnprocessableError(
      `unknown routine ${scheduleId || "(none named)"}; list the routines with studio_list_routines`,
    );
  }
  const agent = rc.members.find((member) => member.id === String(row.agent_id));
  if (!agent) {
    throw new StudioUnprocessableError("the routine's agent is not in the source guild");
  }
  return { id: scheduleId, agent, definition: changedFields(row, {}) };
}

function definitionHash(agentId: string, definition: Definition): string {
  return hashOf([
    agentId,
    definition.timing,
    definition.description,
    definition.instruction,
    definition.paused,
  ]);
}

function render(agent: Member, definition: Definition): string {
  return [
    `agent: ${agent.name}`,
    `description: ${definition.description}`,
    `timing: ${timingText(definition.timing)}`,
    `state: ${definition.paused ? "paused" : "active"}`,
    "instruction:",
    definition.instruction,
  ].join("\n");
}

function targetOf(
  agent: Member,
  scheduleId: string | null,
  description: string,
): RoutineTarget {
  return { agent_id: agent.id, agent_name: agent.name, schedule_id: scheduleId, description };
}

function firingEffect(rc: RoutineContext, paused: boolean): string[] {
  if (paused) return [];
  return rc.routinesEnabled
    ? []
    : [`${rc.guildName}'s routines are off: it fires only once they are turned on.`];
}

function reviewCreate(rc: RoutineContext, call: RoutineCall): RoutineReview {
  const agent = requireMember(rc, call.agentId);
  const definition = valid(() => changedFields(null, scheduleChanges(call.args)));
  return {
    action: "create",
    title: `Create routine for ${agent.name}`,
    target: targetOf(agent, null, definition.description),
    baseHash: hashOf(["absent", agent.id]),
    proposedHash: definitionHash(agent.id, definition),
    live: "",
    proposed: render(agent, definition),
    effects: [
      `Creates a routine that wakes ${agent.name}: ${timingText(definition.timing)}.`,
      definition.paused
        ? "It starts paused and fires once resumed."
        : "Its first wake-up is planned from the moment it is applied.",
      ...firingEffect(rc, definition.paused),
    ],
    plan: { action: "create", agentId: agent.id, definition },
  };
}

function editEffects(rc: RoutineContext, live: Definition, next: Definition): string[] {
  const timingChanged = JSON.stringify(live.timing) !== JSON.stringify(next.timing);
  const effects = [
    ...(timingChanged
      ? [`Wakes ${timingText(next.timing)} instead of ${timingText(live.timing)}.`]
      : []),
    ...(live.instruction !== next.instruction
      ? ["Later wake-ups carry the new instruction; past runs keep the one they fired with."]
      : []),
    ...(live.paused !== next.paused
      ? [next.paused ? "Pauses it: it stops firing until resumed." : "Resumes it."]
      : []),
  ];
  if (!next.paused && (timingChanged || live.paused)) {
    effects.push("Its next wake-up is planned again from the moment it is applied.");
  }
  return [...effects, ...firingEffect(rc, next.paused)];
}

function reviewEdit(rc: RoutineContext, routine: Routine, call: RoutineCall): RoutineReview {
  const changes = scheduleChanges(call.args);
  const next = valid(() => changedFields(routineRow(routine), changes));
  const baseHash = definitionHash(routine.agent.id, routine.definition);
  const proposedHash = definitionHash(routine.agent.id, next);
  if (baseHash === proposedHash) {
    throw new StudioUnprocessableError("the proposal matches the live routine; nothing to change");
  }
  return {
    action: "edit",
    title: `Edit routine ${routine.definition.description}`,
    target: targetOf(routine.agent, routine.id, routine.definition.description),
    baseHash,
    proposedHash,
    live: render(routine.agent, routine.definition),
    proposed: render(routine.agent, next),
    effects: editEffects(rc, routine.definition, next),
    plan: { action: "edit", agentId: routine.agent.id, scheduleId: routine.id, changes },
  };
}

/** A routine's definition in the shape a stored schedule row has. */
function routineRow(routine: Routine): ScheduleDefinition {
  const { timing, ...rest } = routine.definition;
  return timing.window === null
    ? { ...rest, cron: timing.cron, wake_window: null }
    : { ...rest, cron: null, wake_window: timing.window };
}

function reviewDelete(routine: Routine): RoutineReview {
  return {
    action: "delete",
    title: `Delete routine ${routine.definition.description}`,
    target: targetOf(routine.agent, routine.id, routine.definition.description),
    baseHash: definitionHash(routine.agent.id, routine.definition),
    proposedHash: hashOf(["delete", routine.id]),
    live: render(routine.agent, routine.definition),
    proposed: "",
    effects: [
      `Deletes the routine; ${routine.agent.name} is no longer woken by it. Its past runs stay in History.`,
    ],
    plan: { action: "delete", agentId: routine.agent.id, scheduleId: routine.id },
  };
}

/**
 * Checks what a routine proposal does against the live guild. A create names
 * its agent through `call.agentId`; an edit or delete names the routine by
 * `schedule_id`, which stays the same from request to apply.
 */
export async function reviewRoutine(
  deps: EditDeps,
  scope: EditScope,
  action: RoutineAction,
  call: RoutineCall,
): Promise<RoutineReview> {
  const rc = await routineContext(deps, scope);
  if (action === "create") {
    return reviewCreate(rc, call);
  }
  const routine = await loadRoutine(rc, argString(call.args, "schedule_id").trim());
  return action === "edit" ? reviewEdit(rc, routine, call) : reviewDelete(routine);
}

/** Writes a reviewed proposal as the operator. */
export async function applyRoutine(
  deps: EditDeps,
  scope: EditScope,
  plan: RoutinePlan,
): Promise<RoutineChange> {
  try {
    return await writeRoutine(deps, scope, plan);
  } catch (error) {
    scheduleFailure(error);
  }
}

async function writeRoutine(
  deps: EditDeps,
  scope: EditScope,
  plan: RoutinePlan,
): Promise<RoutineChange> {
  if (plan.action === "create") {
    const { timing, description, instruction, paused } = plan.definition;
    const when = { cron: timing.cron, window: timing.window };
    const row = await deps.schedules.create(editActor(scope), plan.agentId, when, description, instruction, {
      paused,
    });
    return { agentId: plan.agentId, action: "create", scheduleId: String(row.id) };
  }
  if (plan.action === "edit") {
    await deps.schedules.update(editActor(scope), plan.agentId, plan.scheduleId, plan.changes);
  } else {
    await deps.schedules.delete(editActor(scope), plan.agentId, plan.scheduleId);
  }
  return { agentId: plan.agentId, action: plan.action, scheduleId: plan.scheduleId };
}
