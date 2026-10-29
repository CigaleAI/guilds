import {
  countOrgMachines,
  deleteMachine,
  getMachine,
  getMachineWithAgents,
  insertMachine,
  listHostedNeeds,
  listMachines,
  lockMachine,
  machineHostsAgents,
  orgHasOtherMachines,
  updateMachine,
} from "../db/machines.js";
import { lockOrg, type OrgMembershipRow } from "../db/orgs.js";
import { isUniqueViolation, type Queryable, withTransaction } from "../db/pg.js";
import type { AgentMachines } from "../generation/machines.js";
import { canManageSettings } from "../organisations/index.js";
import { machineCap, type HeldCap, type OrgPolicy } from "../policy/index.js";
import { visibleGuildIds } from "./access.js";
import {
  agentsMinimum,
  allocatedWorkspaceMib,
  MachineError,
  machineFromRow,
  machineSize,
  machineSizeChanged,
  machineWithAgentsFromRow,
  plannedLoad,
  sizeLabel,
  sizeMeets,
  validateMachineInput,
  type MachineInput,
  type MachineRow,
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
  const row = await getMachineWithAgents(db, orgId, machineId);
  if (row === null) {
    throw new MachineError(404, "machine not found");
  }
  return machineItem(machineWithAgentsFromRow(row), await visibleGuildIds(db, orgId, member.userId));
}

/** The organisation's machines, with the agents on each the member may see. */
export async function listOrgMachines(
  db: Queryable,
  member: MachineMember,
): Promise<Array<Record<string, unknown>>> {
  const orgId = member.membership.id;
  const visible = await visibleGuildIds(db, orgId, member.userId);
  return (await listMachines(db, orgId)).map((row) => machineItem(machineWithAgentsFromRow(row), visible));
}

/** The refusal of a name the organisation already gives another machine; any other error as it is. */
function nameConflict(error: unknown, machine: MachineInput): unknown {
  return isUniqueViolation(error)
    ? new MachineError(409, `${machine.name} is already a machine of this organisation`)
    : error;
}

/**
 * Adds a machine to the organisation. With a `cap`, the machines are counted under the
 * organisation's lock and a full organisation is refused with the cap's error.
 */
async function addMachine(
  db: Queryable,
  orgId: string,
  machine: MachineInput,
  cap: HeldCap | null,
): Promise<MachineRow> {
  try {
    return await withTransaction(db, async (client) => {
      await lockOrg(client, orgId);
      if (cap !== null && (await countOrgMachines(client, orgId)) >= cap.max) {
        throw cap.refuse();
      }
      return machineFromRow(await insertMachine(client, orgId, machine, new Date()));
    });
  } catch (error) {
    throw nameConflict(error, machine);
  }
}

/**
 * Changes a machine's name, tier, size, or disk cap. A size below the minimum of an agent on the
 * machine is refused. Returns the machine before and after the change, or null when there is none.
 */
async function resizeMachine(
  db: Queryable,
  orgId: string,
  machineId: string,
  machine: MachineInput,
): Promise<{ before: MachineRow; after: MachineRow } | null> {
  try {
    return await withTransaction(db, async (client) => {
      const current = await lockMachine(client, orgId, machineId);
      if (current === null) {
        return null;
      }
      const hosted = await listHostedNeeds(client, machineId);
      const minimum = agentsMinimum(hosted);
      if (hosted.length && !sizeMeets(machineSize(machine), minimum)) {
        throw new MachineError(
          409,
          `this machine's agents need at least ${sizeLabel(minimum)}; move them or turn their browser or coding off first`,
        );
      }
      const after = await updateMachine(
        client,
        { org_id: orgId, id: machineId },
        machine,
        new Date(),
      );
      return { before: machineFromRow(current), after: machineFromRow(after) };
    });
  } catch (error) {
    throw nameConflict(error, machine);
  }
}

/**
 * Deletes a machine no agent sits on. One that still hosts agents is refused, and so is the
 * organisation's last machine. Null when there is no such machine.
 */
async function dropMachine(db: Queryable, orgId: string, machineId: string): Promise<MachineRow | null> {
  return withTransaction(db, async (client) => {
    await lockOrg(client, orgId);
    const current = await lockMachine(client, orgId, machineId);
    if (current === null) {
      return null;
    }
    if (await machineHostsAgents(client, machineId)) {
      throw new MachineError(409, "agents are on this machine; move or delete them first");
    }
    if (!(await orgHasOtherMachines(client, orgId, machineId))) {
      throw new MachineError(409, "an organisation keeps at least one machine");
    }
    await deleteMachine(client, machineId);
    return machineFromRow(current);
  });
}

/** Adds a machine, within the policy's machine cap. */
export async function createMachine(
  services: MachineServices,
  member: MachineMember,
  input: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  assertManagesMachines(member);
  const orgId = member.membership.id;
  const machine = await addMachine(
    services.db,
    orgId,
    validateMachineInput(input),
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
  const changed = await resizeMachine(
    services.db,
    orgId,
    machineId,
    validateMachineInput(input, machineFromRow(current)),
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
  if ((await dropMachine(services.db, member.membership.id, machineId)) === null) {
    throw new MachineError(404, "machine not found");
  }
  await services.containers?.deleteMachine(machineId);
}
