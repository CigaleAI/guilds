import {
  deleteMachine,
  getMachine,
  getMachineWithAgents,
  insertMachine,
  listMachines,
  updateMachine,
} from "../db/machines.js";
import type { OrgMembershipRow } from "../db/orgs.js";
import type { Queryable } from "../db/pg.js";
import type { AgentMachines } from "../generation/machines.js";
import { canManageSettings } from "../organisations/index.js";
import { machineCap, type OrgPolicy } from "../policy/index.js";
import { visibleGuildIds } from "./access.js";
import {
  allocatedWorkspaceMib,
  MachineError,
  machineSize,
  machineSizeChanged,
  plannedLoad,
  validateMachineInput,
  type MachineWithAgents,
} from "./index.js";

/** What an organisation's machines are managed through, built once from the app's services. */
export type MachineServices = {
  db: Queryable;
  policy: OrgPolicy;
  /** The containers the machines run in; absent on a box without a generation loop. */
  containers: Pick<AgentMachines, "machineChanged" | "deleteMachine"> | null;
};

/** A member of the organisation acting on its machines: their membership, and who they are. */
export type MachineMember = { membership: OrgMembershipRow; userId: string };

/**
 * A machine as the operator app shows it: its size, the agents on it, their planned load (the sum
 * of their minimums), and its disk with what its agents' own caps reserve of it. Agents of guilds
 * the viewer cannot see count toward the planned load, the reserved disk, and `hidden_agents`,
 * with no name or guild.
 */
export function machineItem(
  machine: MachineWithAgents,
  visibleGuildIds: ReadonlySet<string>,
): Record<string, unknown> {
  const size = machineSize(machine);
  const visible = machine.agents.filter((agent) => visibleGuildIds.has(agent.guild_id));
  const planned = plannedLoad(machine.agents);
  return {
    id: machine.id,
    name: machine.name,
    box: machine.box,
    cpu: size.cpu,
    memory_mib: size.memory_mib,
    max_workspace_mib: machine.max_workspace_mib,
    workspace_mib: machine.workspace_mib,
    allocated_workspace_mib: allocatedWorkspaceMib(machine.agents),
    harnesses: machine.harnesses,
    planned_cpu: planned.cpu,
    planned_mib: planned.memory_mib,
    agents: visible.map((agent) => ({
      id: agent.id,
      name: agent.name,
      guild_id: agent.guild_id,
      guild_name: agent.guild_name,
      browser: agent.browser,
      coding: agent.coding,
    })),
    hidden_agents: machine.agents.length - visible.length,
  };
}

/** Refuses a member who is not an owner or admin: only they manage machines. */
function assertManagesMachines(member: MachineMember): void {
  if (!canManageSettings(member.membership.role)) {
    throw new MachineError(403, "only owners and admins manage machines");
  }
}

async function viewMachine(
  db: Queryable,
  member: MachineMember,
  machineId: string,
): Promise<Record<string, unknown>> {
  const orgId = member.membership.id;
  const machine = await getMachineWithAgents(db, orgId, machineId);
  if (machine === null) {
    throw new MachineError(404, "machine not found");
  }
  return machineItem(machine, await visibleGuildIds(db, orgId, member.userId));
}

/** The organisation's machines, with the agents on each the member may see. */
export async function listOrgMachines(
  db: Queryable,
  member: MachineMember,
): Promise<Array<Record<string, unknown>>> {
  const orgId = member.membership.id;
  const visible = await visibleGuildIds(db, orgId, member.userId);
  return (await listMachines(db, orgId)).map((machine) => machineItem(machine, visible));
}

/** Adds a machine, within the policy's machine cap. */
export async function createMachine(
  services: MachineServices,
  member: MachineMember,
  input: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  assertManagesMachines(member);
  const orgId = member.membership.id;
  const machine = await insertMachine(
    services.db,
    orgId,
    validateMachineInput(input),
    new Date(),
    await machineCap(services.policy, orgId),
  );
  return viewMachine(services.db, member, machine.id);
}

/** Changes a machine; a new size restarts the sandboxes on it. */
export async function changeMachine(
  services: MachineServices,
  member: MachineMember,
  machineId: string,
  input: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  assertManagesMachines(member);
  const orgId = member.membership.id;
  const current = await getMachine(services.db, orgId, machineId);
  if (current === null) {
    throw new MachineError(404, "machine not found");
  }
  const changed = await updateMachine(
    services.db,
    orgId,
    machineId,
    validateMachineInput(input, current),
    new Date(),
  );
  if (changed === null) {
    throw new MachineError(404, "machine not found");
  }
  if (machineSizeChanged(changed.before, changed.after)) {
    await services.containers?.machineChanged(machineId);
  }
  return viewMachine(services.db, member, machineId);
}

/** Deletes a machine that hosts no agent, with its sandboxes. */
export async function removeMachine(
  services: MachineServices,
  member: MachineMember,
  machineId: string,
): Promise<void> {
  assertManagesMachines(member);
  if ((await deleteMachine(services.db, member.membership.id, machineId)) === null) {
    throw new MachineError(404, "machine not found");
  }
  await services.containers?.deleteMachine(machineId);
}
