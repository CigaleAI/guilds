import type { FastifyInstance, FastifyRequest } from "fastify";
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
import type { AppDeps } from "./deps.js";
import { HttpError, missingBodyFields } from "./errors.js";
import { currentUser, identityDatabase } from "./identity.js";
import { isInstanceAdmin } from "./instance-admin.js";
import { bodyOf, param } from "./request.js";

/** The request's organisations, their settings, and their members. */
export async function registerOrgRoutes(app: FastifyInstance, deps: AppDeps): Promise<void> {
  const { db, notes } = deps;
  const identityDb = identityDatabase(db);

  /** The request's membership of the organisation the route names. */
  async function membershipOf(request: FastifyRequest) {
    const user = await currentUser(identityDb, request, deps);
    const membership = await requireMembership(db, param(request, "org_id"), String(user.id));
    return { user, membership };
  }

  app.get("/api/orgs", async (request) => {
    const user = await currentUser(identityDb, request, deps);
    return listUserOrgs(db, String(user.id));
  });

  /** Behind an authenticating proxy only the instance administrator creates organisations. */
  app.post("/api/orgs", async (request, reply) => {
    const user = await currentUser(identityDb, request, deps);
    const compat = (deps.config?.authMode ?? "compat-cookie") === "compat-cookie";
    if (!compat && !(await isInstanceAdmin(deps, String(user.id)))) {
      throw new HttpError(404, "Not Found");
    }
    const missing = missingBodyFields(request.body, ["name", "slug"]);
    if (missing) {
      throw missing;
    }
    const body = bodyOf(request);
    const draft = {
      name: String(body.name ?? ""),
      slug: String(body.slug ?? ""),
      ownerId: String(user.id),
    };
    return reply.code(201).send(await createOrg(db, draft, deps.orgCreated));
  });

  app.get("/api/orgs/:org_id", async (request) => {
    const { membership } = await membershipOf(request);
    return orgItem(membership);
  });

  app.patch("/api/orgs/:org_id", async (request) => {
    const { membership } = await membershipOf(request);
    const body = bodyOf(request);
    const patch: OrgPatch = {
      ...(body.name === undefined ? {} : { name: String(body.name ?? "") }),
      ...(body.slug === undefined ? {} : { slug: String(body.slug ?? "") }),
    };
    return updateOrgSettings(db, notes, membership, patch);
  });

  app.get("/api/orgs/:org_id/members", async (request) => {
    const { membership } = await membershipOf(request);
    return listOrgMembers(db, membership);
  });

  app.post("/api/orgs/:org_id/members", async (request, reply) => {
    const { membership } = await membershipOf(request);
    const body = bodyOf(request);
    if (!("name" in body)) {
      const missing = missingBodyFields(request.body, ["user_id"]);
      if (missing) {
        throw missing;
      }
    }
    const ref: MemberRef =
      "name" in body ? { name: String(body.name ?? "") } : { userId: String(body.user_id) };
    return reply
      .code(201)
      .send(await addOrgMember(db, membership, ref, String(body.role ?? "member")));
  });

  app.patch("/api/orgs/:org_id/members/:user_id", async (request) => {
    const { membership } = await membershipOf(request);
    return changeMemberRole(
      db,
      membership,
      param(request, "user_id"),
      String(bodyOf(request).role ?? ""),
    );
  });

  app.delete("/api/orgs/:org_id/members/:user_id", async (request, reply) => {
    const { user, membership } = await membershipOf(request);
    await removeOrgMember(db, membership, param(request, "user_id"), String(user.id));
    return reply.code(204).send();
  });
}
