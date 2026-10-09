import type { FastifyInstance, FastifyRequest } from "fastify";
import { encryptPayload } from "../credentials/crypto.js";
import { newId } from "../lib/ids.js";
import { providerRequiresOrgKey } from "../llm/catalog.js";
import { LLMError, probeProviderKey } from "../llm/client.js";
import { keyHint, validateModelProvider } from "../llm/org-keys.js";
import { canManageSettings } from "../organisations/index.js";
import type { AppDeps } from "./deps.js";
import { HttpError, missingBodyFields } from "./errors.js";
import { currentUser } from "./identity.js";

function bodyOf(request: FastifyRequest): Record<string, unknown> {
  const body = request.body;
  if (body && typeof body === "object" && !Array.isArray(body)) {
    return body as Record<string, unknown>;
  }
  return {};
}

function param(request: FastifyRequest, name: string): string {
  const value = (request.params as Record<string, string>)[name];
  if (typeof value !== "string") {
    throw new HttpError(404, "Not Found");
  }
  return value;
}

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

function providerItem(row: Record<string, unknown>): Record<string, unknown> {
  return {
    provider: row.provider,
    key_hint: row.key_hint,
    updated_at: row.updated_at,
  };
}

function providerParam(request: FastifyRequest) {
  try {
    return validateModelProvider(param(request, "provider"));
  } catch (error) {
    throw new HttpError(422, error instanceof Error ? error.message : "invalid provider");
  }
}

/** An organisation's own model keys: every member lists them, owners and admins set and remove them. */
export async function registerModelProviderRoutes(app: FastifyInstance, deps: AppDeps): Promise<void> {
  const { repo } = deps;

  app.get("/api/orgs/:org_id/model-providers", async (request) => {
    const orgId = param(request, "org_id");
    await requireMembership(deps, request, orgId);
    return (await repo.listOrgModelProviders(orgId)).map(providerItem);
  });

  app.put("/api/orgs/:org_id/model-providers/:provider", async (request) => {
    const orgId = param(request, "org_id");
    await requireOrgManager(deps, request, orgId);
    const provider = providerParam(request);
    const missing = missingBodyFields(request.body, ["api_key"]);
    if (missing) {
      throw missing;
    }
    const apiKey = String(bodyOf(request).api_key ?? "").trim();
    if (!apiKey) {
      throw new HttpError(422, "api_key is required");
    }
    if (providerRequiresOrgKey(provider)) {
      try {
        await probeProviderKey(provider, apiKey);
      } catch (error) {
        throw new HttpError(422, error instanceof LLMError ? error.message : "couldn't reach the provider");
      }
    }
    const [ciphertext, nonce] = deps.masterKey
      ? encryptPayload({ api_key: apiKey }, deps.masterKey)
      : encryptPayload({ api_key: apiKey });
    const row = await repo.upsertOrgModelProvider(
      newId("mp"),
      orgId,
      provider,
      ciphertext,
      nonce,
      keyHint(apiKey),
      new Date(),
    );
    return providerItem(row);
  });

  app.delete("/api/orgs/:org_id/model-providers/:provider", async (request, reply) => {
    const orgId = param(request, "org_id");
    await requireOrgManager(deps, request, orgId);
    const deleted = await repo.deleteOrgModelProvider(orgId, providerParam(request));
    if (deleted === null) {
      throw new HttpError(404, "model provider not found");
    }
    return reply.code(204).send();
  });
}
