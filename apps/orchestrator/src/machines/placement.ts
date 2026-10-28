import { listMachineSlots, lockAgentPlacement, lockOrgMachines, setAgentMachine } from "../db/machines.js";
import { type Queryable, withTransaction } from "../db/pg.js";
import { assertCanPlaceAgents, machineCounts, type OrgPolicy } from "../policy/index.js";
import { assertCanPlaceOn } from "./access.js";
import {
  agentMinimum,
  belowMinimumMessage,
  lowestFreeSlot,
  MachineError,
  machineFromRow,
  machineSize,
  sizeMeets,
  type AgentNeeds,
  type MachineRow,
} from "./index.js";

/** Where an agent was and where it is, after a move. */
export type MoveAgentResult = {
  from: { machineId: string; slot: number };
  to: { machineId: string; slot: number };
};

/** What an agent with these needs is called in a refusal. */
function needsLabel(needs: AgentNeeds): string {
  if (needs.coding) {
    return "a coding agent";
  }
  return needs.browser ? "a browser agent" : "an agent";
}

/**
 * The machine an agent goes on, locked with the organisation's other machines: the one named, or
 * the organisation's only machine when none is. Refuses a machine below the agent's minimum.
 */
export async function placementMachine(
  db: Queryable,
  orgId: string,
  machineId: string | null | undefined,
  needs: AgentNeeds,
): Promise<MachineRow> {
  const rows = await lockOrgMachines(db, orgId);
  let row = rows.length === 1 && !machineId ? rows[0] : undefined;
  if (machineId) {
    row = rows.find((item) => item.id === machineId);
    if (!row) {
      throw new MachineError(422, "machine_id names no machine of this organisation");
    }
  }
  if (!row) {
    throw new MachineError(
      422,
      rows.length
        ? "machine_id is required: the organisation has more than one machine"
        : "the organisation has no machine",
    );
  }
  const machine = machineFromRow(row);
  if (!sizeMeets(machineSize(machine), agentMinimum(needs))) {
    throw new MachineError(
      422,
      `${belowMinimumMessage(needsLabel(needs), needs, machine)}. Pick a larger machine, or resize ${machine.name} under Settings, Machines`,
    );
  }
  return machine;
}

/** The lowest slot free on a machine, under `ceiling` agents; a full machine is refused. */
export async function freeSlot(
  db: Queryable,
  machine: MachineRow,
  ceiling: number | undefined,
): Promise<number> {
  const slot = lowestFreeSlot(await listMachineSlots(db, machine.id), ceiling);
  if (slot === null) {
    throw new MachineError(409, `machine ${machine.name} is full`);
  }
  return slot;
}

/**
 * Moves an agent to another machine of its organisation, in the lowest free slot there. `needs`
 * is what the agent has on once moved, its saved config's when omitted. Returns where it was and
 * where it is; null when there is no such agent.
 */
export async function moveAgent(
  db: Queryable,
  agentId: string,
  machineId: string,
  options: { maxAgentsPerMachine?: number | null; needs?: AgentNeeds } = {},
): Promise<MoveAgentResult | null> {
  return withTransaction(db, async (client) => {
    const agent = await lockAgentPlacement(client, agentId);
    if (!agent) {
      return null;
    }
    const from = { machineId: agent.machine_id, slot: agent.machine_slot };
    if (from.machineId === machineId) {
      return { from, to: from };
    }
    const needs = options.needs ?? {
      browser: agent.config.browser === true,
      coding: agent.config.coding === true,
    };
    const machine = await placementMachine(client, agent.org_id, machineId, needs);
    const slot = await freeSlot(client, machine, options.maxAgentsPerMachine ?? undefined);
    await setAgentMachine(client, agentId, machine.id, slot);
    return { from, to: { machineId: machine.id, slot } };
  });
}

/** What placements are decided through, built once from the app's services. */
export type PlacementServices = { db: Queryable; policy: OrgPolicy };

/** What an agent's placement is decided over: the machine a request names, the agent's needs, and its machine now. */
export type PlacementRequest = { requested: unknown; needs: AgentNeeds; machineId?: string };

/** The machine an agent goes on, the policy's cap on agents there, and whether it changes machine. */
export type Placement = { machine: MachineRow; maxAgentsPerMachine: number | null; moves: boolean };

/** A request's `machine_id`: a machine id, or null when the request names none. */
export function validateMachineId(value: unknown): string | null {
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value !== "string" || !value) {
    throw new MachineError(422, "machine_id must be a machine id");
  }
  return value;
}

/**
 * The machine an agent goes on, with the policy's per-machine cap: the one named, else the agent's
 * current one, else the organisation's only one. A machine other than the current one must take
 * one more agent and host no agent of a guild the user cannot see.
 */
export async function placeAgent(
  services: PlacementServices,
  orgId: string,
  userId: string,
  request: PlacementRequest,
): Promise<Placement> {
  const { db, policy } = services;
  const named = validateMachineId(request.requested) ?? request.machineId;
  const machine = await placementMachine(db, orgId, named, request.needs);
  if (machine.id === request.machineId) {
    return { machine, maxAgentsPerMachine: null, moves: false };
  }
  await assertCanPlaceOn(db, orgId, machine.id, userId);
  const maxAgentsPerMachine = await assertCanPlaceAgents(
    policy,
    machineCounts(db),
    orgId,
    machine.id,
    1,
  );
  return { machine, maxAgentsPerMachine, moves: true };
}
