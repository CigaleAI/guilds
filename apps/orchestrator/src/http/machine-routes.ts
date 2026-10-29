import type { FastifyInstance, FastifyRequest } from "fastify";
import {
  changeMachine,
  createMachine,
  listOrgMachines,
  removeMachine,
  type MachineMember,
  type MachineServices,
} from "../machines/service.js";
import { requireMembership } from "../organisations/service.js";
import { OPEN_POLICY } from "../policy/index.js";
import type { AppDeps } from "./deps.js";
import { currentUser } from "./identity.js";
import { bodyOf, param } from "./request.js";

/**
 * An organisation's machines: every member lists them; owners and admins create, resize, and
 * delete them. Another organisation's id is a 404.
 */
export async function registerMachineRoutes(app: FastifyInstance, deps: AppDeps): Promise<void> {
  const { db } = deps;
  const services: MachineServices = {
    db,
    policy: deps.policy ?? OPEN_POLICY,
    containers: deps.generation?.machines ?? null,
  };

  async function memberOf(request: FastifyRequest): Promise<MachineMember> {
    const user = await currentUser(db, request, deps);
    const membership = await requireMembership(db, param(request, "org_id"), user.id);
    return { membership, userId: user.id };
  }

  app.get("/api/orgs/:org_id/machines", async (request) =>
    listOrgMachines(db, await memberOf(request)),
  );

  app.post("/api/orgs/:org_id/machines", async (request, reply) => {
    const machine = await createMachine(services, await memberOf(request), bodyOf(request));
    return reply.code(201).send(machine);
  });

  app.patch("/api/orgs/:org_id/machines/:machine_id", async (request) =>
    changeMachine(services, await memberOf(request), param(request, "machine_id"), bodyOf(request)),
  );

  app.delete("/api/orgs/:org_id/machines/:machine_id", async (request, reply) => {
    await removeMachine(services, await memberOf(request), param(request, "machine_id"));
    return reply.code(204).send();
  });
}
