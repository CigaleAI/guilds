import type { Repositories } from "../db/repositories.js";
import { MachineError, type MachineWithAgents } from "./index.js";

/** The ids of the organisation's guilds the user can see. */
export async function visibleGuildIds(repo: Repositories, orgId: string, userId: string): Promise<Set<string>> {
  return new Set((await repo.listGuildsForUser(orgId, userId)).map((guild) => String(guild.id)));
}

/** Whether every agent on the machine belongs to a guild the user can see. */
export function hostsOnlyVisible(machine: MachineWithAgents, visible: ReadonlySet<string>): boolean {
  return machine.agents.every((agent) => visible.has(agent.guild_id));
}

/**
 * Refuses placing an agent on a machine that hosts an agent of a guild the user cannot see: agents
 * on one machine can read each other's homes and sessions (SEC-24).
 */
export async function assertCanPlaceOn(repo: Repositories, orgId: string, machineId: string, userId: string): Promise<void> {
  const machine = await repo.getMachineWithAgents(orgId, machineId);
  if (machine !== null && !hostsOnlyVisible(machine, await visibleGuildIds(repo, orgId, userId))) {
    throw new MachineError(403, "the machine hosts agents of a guild you cannot see");
  }
}
