import type { FastifyInstance, FastifyRequest } from "fastify";
import { modelsDatabase, ModelsError, ModelsService } from "../llm/models.js";
import { coreModelCredentials, modelProviderStore } from "../llm/credentials.js";
import { isProvider } from "../llm/providers.js";
import { requireMembership, requireOrgManager } from "../organisations/service.js";
import type { AppDeps } from "./deps.js";
import { HttpError } from "./errors.js";
import { currentUser } from "./identity.js";
import { identityDatabase } from "../users/identity.js";
import { bodyOf, param } from "./request.js";

async function requireMember(deps: AppDeps, request: FastifyRequest, orgId: string): Promise<void> {
  const user = await currentUser(identityDatabase(deps.db), request, deps);
  await requireMembership(deps.db, orgId, String(user.id));
}

async function requireManager(
  deps: AppDeps,
  request: FastifyRequest,
  orgId: string,
): Promise<void> {
  const user = await currentUser(identityDatabase(deps.db), request, deps);
  await requireOrgManager(deps.db, orgId, String(user.id));
}

function providerParam(request: FastifyRequest): string {
  const provider = param(request, "provider");
  if (!isProvider(provider)) {
    throw new HttpError(422, "unknown model provider");
  }
  return provider;
}

/** The models service the routes answer with: the one composed, or core's over the repository. */
export function modelsOf(deps: AppDeps): ModelsService {
  return (
    deps.models ??
    new ModelsService({
      db: modelsDatabase(deps.db),
      credentials: deps.modelCredentials ?? coreModelCredentials(modelProviderStore(deps.db), deps.masterKey),
      masterKey: deps.masterKey,
    })
  );
}

function mapModelsError(error: unknown): never {
  if (error instanceof ModelsError) {
    throw new HttpError(error.status, error.message);
  }
  throw error;
}

/**
 * An organisation's model setup: every member reads what is offered, owners and admins connect
 * providers, choose their models, and name the default.
 */
export async function registerModelProviderRoutes(app: FastifyInstance, deps: AppDeps): Promise<void> {
  const models = modelsOf(deps);

  app.get("/api/orgs/:org_id/models", async (request) => {
    const orgId = param(request, "org_id");
    await requireMember(deps, request, orgId);
    return models.read(orgId);
  });

  app.get("/api/orgs/:org_id/model-providers/:provider/catalog", async (request) => {
    const orgId = param(request, "org_id");
    await requireMember(deps, request, orgId);
    try {
      return { models: await models.providerCatalog(orgId, providerParam(request)) };
    } catch (error) {
      mapModelsError(error);
    }
  });

  app.put("/api/orgs/:org_id/model-providers/:provider", async (request) => {
    const orgId = param(request, "org_id");
    await requireManager(deps, request, orgId);
    const provider = providerParam(request);
    try {
      return await models.connect(orgId, provider, bodyOf(request));
    } catch (error) {
      mapModelsError(error);
    }
  });

  app.put("/api/orgs/:org_id/default-model", async (request) => {
    const orgId = param(request, "org_id");
    await requireManager(deps, request, orgId);
    try {
      return await models.setDefault(orgId, bodyOf(request).model ?? null);
    } catch (error) {
      mapModelsError(error);
    }
  });

  app.delete("/api/orgs/:org_id/model-providers/:provider", async (request, reply) => {
    const orgId = param(request, "org_id");
    await requireManager(deps, request, orgId);
    const provider = providerParam(request);
    let removed: boolean;
    try {
      removed = await models.remove(orgId, provider);
    } catch (error) {
      mapModelsError(error);
    }
    if (!removed) {
      throw new HttpError(404, "model provider not found");
    }
    return reply.code(204).send();
  });
}
