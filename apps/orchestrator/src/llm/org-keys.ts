import {
  PROVIDERS,
  isCodingOnlyModel,
  missingOrgKeyMessage,
  providerNameForModel,
  providerRequiresOrgKey,
  type Provider,
} from "./catalog.js";

// An organisation's own model keys: the providers it may hold one for, and the check that a
// model which only runs on an organisation key has one.

export const MODEL_PROVIDERS = PROVIDERS;
export type ModelProvider = Provider;

/** Raised when a coding-API model is saved or run without that organisation's key. */
export class ModelKeyRequiredError extends Error {
  status = 422;
  provider: string;

  constructor(provider: string) {
    super(missingOrgKeyMessage(provider));
    this.name = "ModelKeyRequiredError";
    this.provider = provider;
  }
}

/** The last characters of a key, shown in place of it. */
export function keyHint(apiKey: string): string {
  const trimmed = apiKey.trim();
  if (trimmed.length <= 4) {
    return trimmed;
  }
  return trimmed.slice(-4);
}

export function validateModelProvider(provider: string): ModelProvider {
  if (!(MODEL_PROVIDERS as readonly string[]).includes(provider)) {
    throw new Error("unknown model provider");
  }
  return provider as ModelProvider;
}

export async function assertOrgModelKey(
  store: { resolveOrgApiKey(orgId: string, model: string): Promise<string | null> },
  orgId: string,
  model: string,
): Promise<void> {
  if (!isCodingOnlyModel(model)) {
    return;
  }
  const provider = providerNameForModel(model);
  if (!provider || !providerRequiresOrgKey(provider)) {
    return;
  }
  const key = await store.resolveOrgApiKey(orgId, model);
  if (!key) {
    throw new ModelKeyRequiredError(provider);
  }
}
