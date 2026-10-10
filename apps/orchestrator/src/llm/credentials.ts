import { asBuffer, decryptPayload } from "../credentials/crypto.js";
import { writeLog } from "../observability/log.js";
import { PolicyError } from "../policy/index.js";
import type { CostSource, TokenUsage } from "./cost.js";
import { parseModelId, providerLabel, providerById, type ProviderDef } from "./providers.js";

// The credentials a run calls a provider with. Core asks one function for them: an extension
// point (docs/architecture/extension-points.md) whose core default reads the organisation's own
// row. Core knows nothing beyond this: who pays and what the usage callback does are the
// implementation's.

export type ModelUsage = {
  run_id: string;
  model: string;
  usage: TokenUsage;
  cost_usd: number;
  cost_source: CostSource;
};

export type ModelCredentials = {
  apiKey: string;
  baseURL?: string;
  /** Called once per completion; a failure is logged and never fails the run. */
  onUsage?(usage: ModelUsage): Promise<void>;
};

export type ModelCredentialsProvider = {
  /** The credentials of a provider for an organisation, or null while it is not connected. May throw a `PolicyError`. */
  modelCredentials(orgId: string, provider: string): Promise<ModelCredentials | null>;
};

/** The last characters of a key, shown in place of it. */
export function keyHint(apiKey: string): string {
  const trimmed = apiKey.trim();
  if (trimmed.length <= 4) {
    return trimmed;
  }
  return trimmed.slice(-4);
}

export function missingKeyMessage(provider: string): string {
  return `connect a ${providerLabel(provider)} key on Model keys`;
}

/** Raised when a model is saved or run for a provider the organisation has not connected. */
export class ModelNotConnectedError extends Error {
  status = 422;
  provider: string;

  constructor(provider: string, message = missingKeyMessage(provider)) {
    super(message);
    this.name = "ModelNotConnectedError";
    this.provider = provider;
  }
}

export type ModelProviderStore = {
  getOrgModelProvider(orgId: string, provider: string): Promise<Record<string, unknown> | null>;
};

/** The stored secret of a provider row: its key, and the base URL of a local endpoint. */
export function decryptProviderRow(
  row: Record<string, unknown>,
  masterKey?: Buffer,
): { apiKey: string; baseURL: string | null } {
  if (!row.ciphertext || !row.nonce) {
    return { apiKey: "", baseURL: null };
  }
  const payload = decryptPayload(asBuffer(row.ciphertext), asBuffer(row.nonce), masterKey);
  const apiKey = typeof payload.api_key === "string" ? payload.api_key.trim() : "";
  const baseURL = typeof payload.base_url === "string" && payload.base_url.trim() ? payload.base_url.trim() : null;
  return { apiKey, baseURL };
}

/** Core's default: the organisation's row for the provider, and no usage callback. */
export function coreModelCredentials(store: ModelProviderStore, masterKey?: Buffer): ModelCredentialsProvider {
  return {
    async modelCredentials(orgId, provider) {
      const row = await store.getOrgModelProvider(orgId, provider);
      if (!row) {
        return null;
      }
      const secret = decryptProviderRow(row, masterKey);
      const definition = providerById(provider);
      if (definition?.id !== "local" && !secret.apiKey) {
        return null;
      }
      return { apiKey: secret.apiKey, ...(secret.baseURL ? { baseURL: secret.baseURL } : {}) };
    },
  };
}

/** A provider that connects nothing: what a loop runs with when nothing resolves credentials. */
export const NO_CREDENTIALS: ModelCredentialsProvider = {
  async modelCredentials() {
    return null;
  },
};

/** The provider of a stored model id; throws for an id without a provider prefix. */
export function requireProvider(model: string): ProviderDef {
  const parsed = parseModelId(model);
  if (!parsed) {
    throw new ModelNotConnectedError("", "model must be {provider}/{model}");
  }
  return parsed.provider;
}

/** Resolves the credentials a model runs with; throws when the provider is not connected. */
export async function resolveModelCredentials(
  credentials: ModelCredentialsProvider,
  orgId: string,
  model: string,
): Promise<ModelCredentials> {
  const provider = requireProvider(model);
  const resolved = await credentials.modelCredentials(orgId, provider.id);
  if (!resolved) {
    throw new ModelNotConnectedError(provider.id);
  }
  return resolved;
}

/** The check a save runs: the model's provider is connected for the organisation. */
export async function assertModelConnected(
  credentials: ModelCredentialsProvider,
  orgId: string,
  model: string,
): Promise<void> {
  await resolveModelCredentials(credentials, orgId, model);
}

export function isPolicyError(error: unknown): error is PolicyError {
  return error instanceof PolicyError;
}

/** What a completion's metadata says about its usage, for the credentials' callback. */
export function modelUsageOf(runId: string, model: string, metadata: Record<string, unknown>): ModelUsage {
  const usage = (metadata.usage ?? {}) as Partial<TokenUsage>;
  const source = metadata.cost_source;
  return {
    run_id: runId,
    model,
    usage: {
      input_tokens: Number(usage.input_tokens ?? 0),
      output_tokens: Number(usage.output_tokens ?? 0),
      cache_read_tokens: Number(usage.cache_read_tokens ?? 0),
    },
    cost_usd: Number(metadata.cost_usd ?? 0),
    cost_source: source === "provider" || source === "catalog" ? source : "unavailable",
  };
}

/** Reports a completion's usage to the credentials' callback; a failure is logged and swallowed. */
export async function reportModelUsage(credentials: ModelCredentials, usage: ModelUsage): Promise<void> {
  if (!credentials.onUsage) {
    return;
  }
  try {
    await credentials.onUsage(usage);
  } catch (error) {
    writeLog(
      "warn",
      "model usage callback failed",
      { source: "backend", operation: "models.usage_callback", run_id: usage.run_id },
      error,
    );
  }
}
