import type { FastifyInstance, FastifyRequest } from "fastify";
import { ModelsError, ModelsService } from "../llm/models.js";
import { coreModelCredentials } from "../llm/credentials.js";
import { isProvider } from "../llm/providers.js";
import { canManageSettings } from "../organisations/index.js";
import type { AppDeps } from "./deps.js";
import { HttpError } from "./errors.js";
import { currentUser } from "./identity.js";
import { bodyOf, param } from "./request.js";

async function requireMembership(
  deps: AppDeps,
  request: FastifyRequest,
  orgId: string,
): Promise<Record<string, unknown>> {
  const user = await currentUser(deps.repo, request, deps);
  const membership = await deps.repo.getMembership(orgId, String(user.id));
  if (membership === null) {
    throw new HttpError(404, "organisation not found");
  }
  return membership;
}

async function requireOrgManager(deps: AppDeps, request: FastifyRequest, orgId: string): Promise<void> {
  const membership = await requireMembership(deps, request, orgId);
  if (!canManageSettings(String(membership.role))) {
    throw new HttpError(404, "organisation not found");
  }
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
      repo: deps.repo,
      credentials: deps.modelCredentials ?? coreModelCredentials(deps.repo, deps.masterKey),
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
    await requireMembership(deps, request, orgId);
    return models.read(orgId);
  });

  app.get("/api/orgs/:org_id/model-providers/:provider/catalog", async (request) => {
    const orgId = param(request, "org_id");
    await requireMembership(deps, request, orgId);
    try {
      return { models: await models.providerCatalog(orgId, providerParam(request)) };
    } catch (error) {
      mapModelsError(error);
    }
  });

  app.put("/api/orgs/:org_id/model-providers/:provider", async (request) => {
    const orgId = param(request, "org_id");
    await requireOrgManager(deps, request, orgId);
    const provider = providerParam(request);
    try {
      return await models.connect(orgId, provider, bodyOf(request));
    } catch (error) {
      mapModelsError(error);
    }
  });

  app.put("/api/orgs/:org_id/default-model", async (request) => {
    const orgId = param(request, "org_id");
    await requireOrgManager(deps, request, orgId);
    try {
      return await models.setDefault(orgId, bodyOf(request).model ?? null);
    } catch (error) {
      mapModelsError(error);
    }
  });

  app.delete("/api/orgs/:org_id/model-providers/:provider", async (request, reply) => {
    const orgId = param(request, "org_id");
    await requireOrgManager(deps, request, orgId);
    if (!(await models.remove(orgId, providerParam(request)))) {
      throw new HttpError(404, "model provider not found");
    }
    return reply.code(204).send();
  });
}
