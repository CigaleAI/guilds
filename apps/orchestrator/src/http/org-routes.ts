import { Type } from "@sinclair/typebox";
import type { FastifyRequest } from "fastify";
import { orgItem } from "../organisations/index.js";
import {
  addOrgMember,
  changeMemberRole,
  createOrg,
  listOrgMembers,
  listUserOrgs,
  removeOrgMember,
  requireMembership,
  updateOrgSettings,
  type MemberRef,
  type OrgPatch,
} from "../organisations/service.js";
import type { AppDeps, RouteApp } from "./deps.js";
import { HttpError } from "./errors.js";
import { currentUser, type IdentityRequest } from "./identity.js";
import { isInstanceAdmin } from "./instance-admin.js";
import { OrgParams } from "./params.js";

/** A new organisation: its name and its slug. */
const OrgDraftSchema = Type.Object({ name: Type.String(), slug: Type.String() });

/** A change to an organisation's name or slug; a field left out keeps its value. */
const OrgPatchSchema = Type.Object({
  name: Type.Optional(Type.String()),
  slug: Type.Optional(Type.String()),
});

/** A user added to an organisation, by name or by id, with their role (`member` when left out). */
const NewMemberSchema = Type.Union([
  Type.Object({ name: Type.String(), role: Type.Optional(Type.String()) }),
  Type.Object({ user_id: Type.String(), role: Type.Optional(Type.String()) }),
]);

/** The role a member is given. */
const MemberRoleSchema = Type.Object({ role: Type.String() });

/** The path of one member of an organisation. */
const MemberParams = Type.Object({ org_id: Type.String(), user_id: Type.String() });

/** The request's organisations, their settings, and their members. */
export async function registerOrgRoutes(app: RouteApp, deps: AppDeps): Promise<void> {
  const { db, notes } = deps;

  /** The request's membership of the organisation the route names. */
  async function membershipOf(request: FastifyRequest, orgId: string) {
    const user = await currentUser(db, request, deps);
    const membership = await requireMembership(db, orgId, user.id);
    return { user, membership };
  }

  /**
   * Behind an authenticating proxy only the instance administrator creates organisations; the
   * create route runs this as its `preValidation` hook, so anyone else gets the same 404 whatever
   * they send.
   */
  async function requireOrgCreator(request: IdentityRequest): Promise<void> {
    const user = await currentUser(db, request, deps);
    const compat = (deps.config?.authMode ?? "compat-cookie") === "compat-cookie";
    if (!compat && !(await isInstanceAdmin(deps, user.id))) {
      throw new HttpError(404, "Not Found");
    }
  }

  app.get("/api/orgs", async (request) => {
    const user = await currentUser(db, request, deps);
    return listUserOrgs(db, user.id);
  });

  app.post(
    "/api/orgs",
    { preValidation: requireOrgCreator, schema: { body: OrgDraftSchema } },
    async (request, reply) => {
      const user = await currentUser(db, request, deps);
      const draft = { name: request.body.name, slug: request.body.slug, ownerId: user.id };
      return reply.code(201).send(await createOrg(db, draft, deps.orgCreated));
    },
  );

  app.get("/api/orgs/:org_id", { schema: { params: OrgParams } }, async (request) => {
    const { membership } = await membershipOf(request, request.params.org_id);
    return orgItem(membership);
  });

  app.patch(
    "/api/orgs/:org_id",
    { schema: { params: OrgParams, body: OrgPatchSchema } },
    async (request) => {
      const { membership } = await membershipOf(request, request.params.org_id);
      const { name, slug } = request.body;
      const patch: OrgPatch = {
        ...(name === undefined ? {} : { name }),
        ...(slug === undefined ? {} : { slug }),
      };
      return updateOrgSettings(db, notes, membership, patch);
    },
  );

  app.get("/api/orgs/:org_id/members", { schema: { params: OrgParams } }, async (request) => {
    const { membership } = await membershipOf(request, request.params.org_id);
    return listOrgMembers(db, membership);
  });

  app.post(
    "/api/orgs/:org_id/members",
    { schema: { params: OrgParams, body: NewMemberSchema } },
    async (request, reply) => {
      const { membership } = await membershipOf(request, request.params.org_id);
      const body = request.body;
      const ref: MemberRef = "name" in body ? { name: body.name } : { userId: body.user_id };
      return reply
        .code(201)
        .send(await addOrgMember(db, membership, ref, body.role ?? "member"));
    },
  );

  app.patch(
    "/api/orgs/:org_id/members/:user_id",
    { schema: { params: MemberParams, body: MemberRoleSchema } },
    async (request) => {
      const { membership } = await membershipOf(request, request.params.org_id);
      return changeMemberRole(db, membership, request.params.user_id, request.body.role);
    },
  );

  app.delete(
    "/api/orgs/:org_id/members/:user_id",
    { schema: { params: MemberParams } },
    async (request, reply) => {
      const { user, membership } = await membershipOf(request, request.params.org_id);
      await removeOrgMember(db, membership, request.params.user_id, user.id);
      return reply.code(204).send();
    },
  );
}
