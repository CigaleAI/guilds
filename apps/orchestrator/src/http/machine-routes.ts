import { Type } from "@sinclair/typebox";
import type { FastifyRequest } from "fastify";
import { MachineBodySchema } from "../machines/index.js";
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
import type { AppDeps, RouteApp } from "./deps.js";
import { currentUser } from "./identity.js";
import { OrgParams } from "./params.js";

/** The path of one machine of an organisation. */
const MachineParams = Type.Object({ org_id: Type.String(), machine_id: Type.String() });

/**
 * An organisation's machines: every member lists them; owners and admins create, resize, and
 * delete them. Another organisation's id is a 404.
 */
export async function registerMachineRoutes(app: RouteApp, deps: AppDeps): Promise<void> {
  const { db } = deps;
  const services: MachineServices = {
    db,
    policy: deps.policy ?? OPEN_POLICY,
    containers: deps.generation?.machines ?? null,
  };

  async function memberOf(request: FastifyRequest, orgId: string): Promise<MachineMember> {
    const user = await currentUser(db, request, deps);
    const membership = await requireMembership(db, orgId, user.id);
    return { membership, userId: user.id };
  }

  app.get("/api/orgs/:org_id/machines", { schema: { params: OrgParams } }, async (request) =>
    listOrgMachines(db, await memberOf(request, request.params.org_id)),
  );

  app.post(
    "/api/orgs/:org_id/machines",
    { schema: { params: OrgParams, body: MachineBodySchema } },
    async (request, reply) => {
      const member = await memberOf(request, request.params.org_id);
      return reply.code(201).send(await createMachine(services, member, request.body));
    },
  );

  app.patch(
    "/api/orgs/:org_id/machines/:machine_id",
    { schema: { params: MachineParams, body: MachineBodySchema } },
    async (request) => {
      const member = await memberOf(request, request.params.org_id);
      return changeMachine(services, member, request.params.machine_id, request.body);
    },
  );

  app.delete(
    "/api/orgs/:org_id/machines/:machine_id",
    { schema: { params: MachineParams } },
    async (request, reply) => {
      const member = await memberOf(request, request.params.org_id);
      await removeMachine(services, member, request.params.machine_id);
      return reply.code(204).send();
    },
  );
}
