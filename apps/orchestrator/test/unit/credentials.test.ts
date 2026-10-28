import assert from "node:assert/strict";
import { completionMetadata } from "../helpers/generation.js";
import { test } from "node:test";
import { encryptPayload } from "../../src/credentials/crypto.js";
import type { OrgModelProviderRow } from "../../src/db/orgs.js";
import {
  ModelNotConnectedError,
  assertModelConnected,
  coreModelCredentials,
  keyHint,
  modelUsageOf,
  reportModelUsage,
  resolveModelCredentials,
} from "../../src/llm/credentials.js";
import { PolicyError } from "../../src/policy/index.js";
import { TEST_MASTER_KEY } from "../helpers/models.js";

function row(payload: Record<string, unknown>): OrgModelProviderRow {
  const [ciphertext, nonce] = encryptPayload(payload, TEST_MASTER_KEY);
  return {
    id: "mp_1",
    org_id: "org_1",
    provider: "openrouter",
    ciphertext,
    nonce,
    key_hint: "abcd",
    models: [],
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
  };
}

test("keyHint keeps the last four characters", () => {
  assert.equal(keyHint("sk-or-v1-abcdef"), "cdef");
  assert.equal(keyHint("ab"), "ab");
});

test("core's credentials are the organisation's row: its key, and a local endpoint's URL", async () => {
  const rows = new Map<string, OrgModelProviderRow>([
    ["org_1/openrouter", row({ api_key: " sk-or-key " })],
    ["org_1/local", row({ api_key: "", base_url: "http://127.0.0.1:11434/v1" })],
    ["org_1/xai", row({ api_key: "" })],
  ]);
  const credentials = coreModelCredentials(
    { getOrgModelProvider: async (orgId, provider) => rows.get(`${orgId}/${provider}`) ?? null },
    TEST_MASTER_KEY,
  );
  assert.deepEqual(await credentials.modelCredentials("org_1", "openrouter"), { apiKey: "sk-or-key" });
  assert.deepEqual(await credentials.modelCredentials("org_1", "local"), {
    apiKey: "",
    baseURL: "http://127.0.0.1:11434/v1",
  });
  assert.equal(await credentials.modelCredentials("org_1", "xai"), null, "a row without a key is not connected");
  assert.equal(await credentials.modelCredentials("org_1", "kimi"), null);
  assert.equal(await credentials.modelCredentials("org_2", "openrouter"), null);
});

test("a model is connected when its provider's credentials resolve", async () => {
  const connected = { modelCredentials: async () => ({ apiKey: "k" }) };
  const none = { modelCredentials: async () => null };
  await assertModelConnected(connected, "org_1", "openrouter/openai/gpt-5.6-luna");
  await assert.rejects(
    () => assertModelConnected(none, "org_1", "kimi/kimi-for-coding"),
    (error: unknown) =>
      error instanceof ModelNotConnectedError &&
      error.status === 422 &&
      error.provider === "kimi" &&
      error.message === "connect a Kimi Code key on Model keys",
  );
  await assert.rejects(
    () => resolveModelCredentials(connected, "org_1", "gpt-5"),
    (error: unknown) => error instanceof ModelNotConnectedError && /\{provider\}\/\{model\}/.test(error.message),
  );
  const refusing = {
    modelCredentials: async () => {
      throw new PolicyError(402, "trial ended");
    },
  };
  await assert.rejects(() => assertModelConnected(refusing, "org_1", "openai/gpt-5"), PolicyError);
});

test("usage is read from a completion's metadata and the callback's failure is swallowed", async () => {
  const usage = modelUsageOf(
    "r_1",
    "openai/gpt-5",
    completionMetadata({ usage: { input_tokens: 10, output_tokens: 4, cache_read_tokens: 2 }, cost_usd: 0.5, cost_source: "provider" }),
  );
  assert.deepEqual(usage, {
    run_id: "r_1",
    model: "openai/gpt-5",
    usage: { input_tokens: 10, output_tokens: 4, cache_read_tokens: 2 },
    cost_usd: 0.5,
    cost_source: "provider",
  });
  assert.equal(modelUsageOf("r_1", "m", completionMetadata({ cost_source: "unavailable" })).cost_source, "unavailable");
  const heard: string[] = [];
  await reportModelUsage(
    {
      apiKey: "k",
      onUsage: async (item) => {
        heard.push(item.run_id);
        throw new Error("down");
      },
    },
    usage,
  );
  assert.deepEqual(heard, ["r_1"]);
  await reportModelUsage({ apiKey: "k" }, usage);
});
