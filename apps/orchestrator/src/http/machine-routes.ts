import type { FastifyInstance, FastifyRequest } from "fastify";
import { visibleGuildIds } from "../machines/access.js";
import {
  machineSize,
  machineSizeChanged,
  plannedMib,
  validateMachineInput,
  type MachineWithAgents,
} from "../machines/index.js";
import { canManageSettings } from "../organisations/index.js";
import { OPEN_POLICY, machineCap } from "../policy/index.js";
import type { AppDeps } from "./deps.js";
import { HttpError } from "./errors.js";
import { currentUser } from "./identity.js";
import { bodyOf, param } from "./request.js";

/**
 * A machine as the operator app shows it: its size, the agents on it, their planned memory, and
 * its disk. Agents of guilds the viewer cannot see count toward the planned memory and
 * `hidden_agents`, with no name or guild.
 */
export function machineItem(machine: MachineWithAgents, visibleGuildIds: ReadonlySet<string>): Record<string, unknown> {
  const size = machineSize(machine);
  const visible = machine.agents.filter((agent) => visibleGuildIds.has(agent.guild_id));
  return {
    id: machine.id,
    name: machine.name,
    box: machine.box,
    cpu: size.cpu,
    memory_mib: size.memory_mib,
    max_workspace_mib: machine.max_workspace_mib,
    workspace_mib: machine.workspace_mib,
    harnesses: machine.harnesses,
    planned_mib: plannedMib(machine.agents),
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

/** A body's `machine_id`: a machine id, or null when the body names none. */
export function machineIdOf(value: unknown): string | null {
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value !== "string" || !value) {
    throw new HttpError(422, "machine_id must be a machine id");
  }
  return value;
}

/**
 * An organisation's machines: every member lists them; owners and admins create, resize, and
 * delete them. Another organisation's id is a 404.
 */
export async function registerMachineRoutes(app: FastifyInstance, deps: AppDeps): Promise<void> {
  const { repo } = deps;
  const policy = deps.policy ?? OPEN_POLICY;

  async function requireMember(request: FastifyRequest): Promise<{ orgId: string; userId: string; role: string }> {
    const orgId = param(request, "org_id");
    const user = await currentUser(repo, request, deps);
    const membership = await repo.getMembership(orgId, String(user.id));
    if (membership === null) {
      throw new HttpError(404, "organisation not found");
    }
    return { orgId, userId: String(user.id), role: String(membership.role) };
  }

  async function requireManager(request: FastifyRequest): Promise<{ orgId: string; userId: string }> {
    const member = await requireMember(request);
    if (!canManageSettings(member.role)) {
      throw new HttpError(403, "only owners and admins manage machines");
    }
    return member;
  }

  async function itemOf(orgId: string, machineId: string, userId: string): Promise<Record<string, unknown>> {
    const machine = await repo.getMachineWithAgents(orgId, machineId);
    if (machine === null) {
      throw new HttpError(404, "machine not found");
    }
    return machineItem(machine, await visibleGuildIds(repo, orgId, userId));
  }

  app.get("/api/orgs/:org_id/machines", async (request) => {
    const { orgId, userId } = await requireMember(request);
    const visible = await visibleGuildIds(repo, orgId, userId);
    return (await repo.listMachines(orgId)).map((machine) => machineItem(machine, visible));
  });

  app.post("/api/orgs/:org_id/machines", async (request, reply) => {
    const { orgId, userId } = await requireManager(request);
    const input = validateMachineInput(bodyOf(request));
    const machine = await repo.insertMachine(orgId, input, new Date(), await machineCap(policy, orgId));
    reply.code(201);
    return await itemOf(orgId, machine.id, userId);
  });

  app.patch("/api/orgs/:org_id/machines/:machine_id", async (request) => {
    const { orgId, userId } = await requireManager(request);
    const machineId = param(request, "machine_id");
    const current = await repo.getMachine(orgId, machineId);
    if (current === null) {
      throw new HttpError(404, "machine not found");
    }
    const changed = await repo.updateMachine(orgId, machineId, validateMachineInput(bodyOf(request), current), new Date());
    if (changed === null) {
      throw new HttpError(404, "machine not found");
    }
    if (machineSizeChanged(changed.before, changed.after)) {
      await deps.generation?.machineChanged(machineId);
    }
    return await itemOf(orgId, machineId, userId);
  });

  app.delete("/api/orgs/:org_id/machines/:machine_id", async (request, reply) => {
    const { orgId } = await requireManager(request);
    const machineId = param(request, "machine_id");
    if ((await repo.deleteMachine(orgId, machineId)) === null) {
      throw new HttpError(404, "machine not found");
    }
    await deps.generation?.deleteMachine(machineId);
    return reply.code(204).send();
  });
}
