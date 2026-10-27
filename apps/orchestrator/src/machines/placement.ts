import { placementMachine } from "../db/machines.js";
import type { Queryable } from "../db/pg.js";
import { assertCanPlaceAgents, machineCounts, type OrgPolicy } from "../policy/index.js";
import { assertCanPlaceOn } from "./access.js";
import { MachineError, type AgentNeeds, type MachineRow } from "./index.js";

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
