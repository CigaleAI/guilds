import { encryptPayload } from "../../src/credentials/crypto.js";
import type { NewOrgModelProvider } from "../../src/db/orgs.js";
import { newId } from "../../src/lib/ids.js";
import type { ModelCredentialsProvider } from "../../src/llm/credentials.js";
import { HEX_MASTER_KEY } from "./env.js";

/** The model the fixtures and recordings run on; its provider is connected with `connectModelProvider`. */
export const TEST_MODEL = "deepinfra/zai-org/GLM-5.3-Flash";
export const TEST_MASTER_KEY = Buffer.from(HEX_MASTER_KEY, "hex");

/** Credentials that resolve for every provider: what a loop under test runs with. */
export const TEST_CREDENTIALS: ModelCredentialsProvider = {
  async modelCredentials() {
    return { apiKey: "test-key" };
  },
};

type ProviderStore = {
  upsertOrgModelProvider(
    provider: NewOrgModelProvider,
    now: Date,
  ): Promise<Record<string, unknown>>;
};

/**
 * Connects a provider for an organisation without probing it: the row the app, the loop, and the
 * coaches decrypt with the test master key, which this sets for the process when none is set.
 */
export async function connectModelProvider(
  repo: ProviderStore,
  orgId: string,
  provider: string,
  options: { apiKey?: string; baseURL?: string; models?: string[] } = {},
): Promise<void> {
  process.env.SECRETS_MASTER_KEY ??= HEX_MASTER_KEY;
  const apiKey = options.apiKey ?? `sk-${provider}-test-abcd`;
  const payload: Record<string, unknown> = { api_key: apiKey };
  if (options.baseURL) {
    payload.base_url = options.baseURL;
  }
  const [ciphertext, nonce] = encryptPayload(payload, TEST_MASTER_KEY);
  await repo.upsertOrgModelProvider(
    {
      providerId: newId("mp"),
      orgId,
      provider,
      ciphertext,
      nonce,
      keyHint: apiKey ? apiKey.slice(-4) : null,
      models: options.models ?? [],
    },
    new Date(),
  );
}
