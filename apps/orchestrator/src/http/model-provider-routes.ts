import { Type } from "@sinclair/typebox";
import type { FastifyRequest } from "fastify";
import {
  DefaultModelSchema,
  modelsService,
  ProviderConnectionSchema,
  type ModelsService,
} from "../llm/models.js";
import { isProvider } from "../llm/providers.js";
import { requireMembership, requireOrgManager } from "../organisations/service.js";
import type { AppDeps, RouteApp } from "./deps.js";
import { HttpError } from "./errors.js";
import { currentUser } from "./identity.js";
import { OrgParams } from "./params.js";

/** The path of one model provider of an organisation. */
const ProviderParams = Type.Object({ org_id: Type.String(), provider: Type.String() });

async function requireMember(deps: AppDeps, request: FastifyRequest, orgId: string): Promise<void> {
  const user = await currentUser(deps.db, request, deps);
  await requireMembership(deps.db, orgId, user.id);
}

async function requireManager(
  deps: AppDeps,
  request: FastifyRequest,
  orgId: string,
): Promise<void> {
  const user = await currentUser(deps.db, request, deps);
  await requireOrgManager(deps.db, orgId, user.id);
}

function knownProvider(provider: string): string {
  if (!isProvider(provider)) {
    throw new HttpError(422, "unknown model provider");
  }
  return provider;
}

/** The models service the routes answer with: the one composed, or core's over the repository. */
export function modelsOf(deps: AppDeps): ModelsService {
  return (
    deps.models ??
    modelsService(deps.db, { credentials: deps.modelCredentials, masterKey: deps.masterKey })
  );
}

/**
 * An organisation's model setup: every member reads what is offered, owners and admins connect
 * providers, choose their models, and name the default.
 */
export async function registerModelProviderRoutes(app: RouteApp, deps: AppDeps): Promise<void> {
  const models = modelsOf(deps);

  app.get("/api/orgs/:org_id/models", { schema: { params: OrgParams } }, async (request) => {
    const orgId = request.params.org_id;
    await requireMember(deps, request, orgId);
    return models.read(orgId);
  });

  app.get(
    "/api/orgs/:org_id/model-providers/:provider/catalog",
    { schema: { params: ProviderParams } },
    async (request) => {
      const orgId = request.params.org_id;
      await requireMember(deps, request, orgId);
      return {
        models: await models.providerCatalog(orgId, knownProvider(request.params.provider)),
      };
    },
  );

  app.put(
    "/api/orgs/:org_id/model-providers/:provider",
    { schema: { params: ProviderParams, body: ProviderConnectionSchema } },
    async (request) => {
      const orgId = request.params.org_id;
      await requireManager(deps, request, orgId);
      const provider = knownProvider(request.params.provider);
      return await models.connect(orgId, provider, request.body);
    },
  );

  app.put(
    "/api/orgs/:org_id/default-model",
    { schema: { params: OrgParams, body: DefaultModelSchema } },
    async (request) => {
      const orgId = request.params.org_id;
      await requireManager(deps, request, orgId);
      return await models.setDefault(orgId, request.body.model ?? null);
    },
  );

  app.delete(
    "/api/orgs/:org_id/model-providers/:provider",
    { schema: { params: ProviderParams } },
    async (request, reply) => {
      const orgId = request.params.org_id;
      await requireManager(deps, request, orgId);
      const removed = await models.remove(orgId, knownProvider(request.params.provider));
      if (!removed) {
        throw new HttpError(404, "model provider not found");
      }
      return reply.code(204).send();
    },
  );
}
