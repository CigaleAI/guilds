import { operatorActor } from "../artifacts/actors.js";
import { deleteCollection } from "../artifacts/collections.js";
import { deleteAgent, listAgents } from "../db/agents.js";
import { deleteGuild } from "../db/guilds.js";
import { getRecipeApply, latestGuildApply, markApplyAborted, markApplyReady, type RecipeApplyRow } from "../db/recipe-applies.js";
import { listSchedules } from "../db/schedules.js";
import type { ChangeActor } from "../lib/change-actor.js";
import type { RecipeApply } from "./apply.js";
import { appliedRecipe, blockingApplySteps, browserLoginAgentIds, deferLaunchSteps } from "./checklist.js";
import { RecipeError } from "./errors.js";
import { schedulesForRole } from "./prepare.js";

// An apply from its open checklist to its close: activated, which unpauses its routines, or
// aborted, which removes the guild it created.

export async function getApply(apply: RecipeApply, applyId: string): Promise<RecipeApplyRow | null> {
  return getRecipeApply(apply.db, applyId);
}

/** The open checklist, and agents whose recipe login was deferred until after activate. */
export async function guildApplyState(
  apply: RecipeApply,
  guildId: string,
): Promise<{ apply: RecipeApplyRow | null; browser_logins: string[] }> {
  const open = await latestGuildApply(apply.db, guildId, ["skeleton", "checklist"]);
  if (open) return { apply: open, browser_logins: [] };
  return { apply: null, browser_logins: browserLoginAgentIds(await latestGuildApply(apply.db, guildId, ["ready"])) };
}

/** Unpauses the routines of a role's agent whose keys the plan activates. */
async function unpauseRoutines(apply: RecipeApply, routine: { agentId: string; keys: string[]; activate: Set<string> }, actor: ChangeActor): Promise<void> {
  const rows = await listSchedules(apply.db, routine.agentId);
  for (const [index, row] of rows.entries()) {
    const key = routine.keys[index];
    if (key && routine.activate.has(key)) {
      await apply.schedules.setPaused(actor, routine.agentId, row.id, false);
    }
  }
}

/** Closes the checklist once nothing blocks it: browser logins wait for later and the planned routines start. */
export async function activateApply(apply: RecipeApply, row: RecipeApplyRow, actor: ChangeActor): Promise<RecipeApplyRow> {
  const now = new Date();
  const checklist = deferLaunchSteps(row.checklist, now);
  const open = blockingApplySteps(checklist);
  if (open.length) {
    throw new RecipeError(`checklist still open: ${open.map((item) => item.id).join(", ")}`);
  }
  const names = row.plan.names;
  const recipe = await appliedRecipe(apply, row.recipe_id);
  const activate = new Set(row.plan.activate_keys);
  for (const role of recipe.roles) {
    const agentId = names.find((item) => item.role === role.role)?.agent_id;
    if (agentId) {
      const keys = schedulesForRole(role, recipe).map((item) => item.key);
      await unpauseRoutines(apply, { agentId, keys, activate }, actor);
    }
  }
  const ready = await markApplyReady(apply.db, row.id, checklist, now);
  if (!ready) {
    throw new RecipeError("apply not found", 404);
  }
  return ready;
}

/** Removes the guild an apply created, with its agents and the collections it created; each removal goes on when another fails. */
async function removeCreatedGuild(apply: RecipeApply, row: RecipeApplyRow, guildId: string): Promise<void> {
  for (const member of await listAgents(apply.db, guildId)) {
    await deleteAgent(apply.db, member.id).catch(() => undefined);
  }
  await deleteGuild(apply.db, guildId).catch(() => undefined);
  const actor = operatorActor({ orgId: row.org_id, actorId: row.created_by_user_id ?? row.org_id, actorName: "operator" });
  for (const item of row.plan.collections) {
    if (item.action === "create" && item.collection_id) {
      await deleteCollection(apply.artifacts, actor, item.collection_id).catch(() => undefined);
    }
  }
}

/** Aborts an apply that is not ready yet, removing the guild it created. */
export async function abortApply(apply: RecipeApply, row: RecipeApplyRow): Promise<RecipeApplyRow> {
  if (row.status === "ready") {
    throw new RecipeError("completed apply cannot be aborted");
  }
  if (row.created_guild && row.guild_id) {
    await removeCreatedGuild(apply, row, row.guild_id);
  }
  const aborted = await markApplyAborted(apply.db, row.id, new Date());
  if (!aborted) {
    throw new RecipeError("apply not found", 404);
  }
  return aborted;
}
