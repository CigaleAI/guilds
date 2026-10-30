import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { createAgent, reconfigureAgent, type AgentRequest, type AgentServices } from "../../src/agents/service.js";
import { AgentValidationError } from "../../src/agents/validation.js";
import { operatorActor } from "../../src/artifacts/actors.js";
import type { GuildRow } from "../../src/db/guilds.js";
import type { Queryable } from "../../src/db/pg.js";
import { ModelNotConnectedError, type ModelCredentialsProvider } from "../../src/llm/credentials.js";
import { OPEN_POLICY } from "../../src/policy/index.js";
import { NotesStore } from "../../src/notes/store.js";
import { setInstanceKeys } from "../../src/instance/integrations.js";
import { clearInstanceKeys, storeKeys, tempDir } from "../helpers/env.js";
import { agentRow } from "../helpers/generation.js";

const MODEL = "openrouter/openai/gpt-5.6-luna";
/** A model of a provider the organisation has not connected. */
const UNCONNECTED_MODEL = "deepinfra/zai-org/GLM-5.3-Flash";
const OPTIMIZED = { model: MODEL, browser: true, browser_optimized: true, browser_model: MODEL };

/** Thrown by the database: a save that reaches it got past every check before it. */
class ReachedDatabase extends Error {}

const CREDENTIALS: ModelCredentialsProvider = {
  async modelCredentials(_orgId, provider) {
    return provider === "openrouter" ? { apiKey: "test-key" } : null;
  },
};

function services(): AgentServices {
  const db = {
    query: async () => {
      throw new ReachedDatabase();
    },
  } as unknown as Queryable;
  return {
    db,
    notes: new NotesStore(tempDir("guilds-browser-config-"), tempDir("guilds-templates-")),
    artifacts: null,
    policy: OPEN_POLICY,
    modelCredentials: CREDENTIALS,
    generation: null,
  };
}

const GUILD = { id: "guild_1", org_id: "org_1", name: "research", org_slug: "acme", operators: [] } as unknown as GuildRow;
const OPERATOR = operatorActor({ orgId: "org_1", actorId: "user_1", actorName: "operator" });

function request(config: Record<string, unknown>): AgentRequest {
  return {
    name: "scout",
    focus: "",
    wakeTriggers: "",
    avatarShape: undefined,
    avatarColor: undefined,
    config,
    machineId: undefined,
  };
}

function patch(config: Record<string, unknown>) {
  return {
    config,
    machineId: undefined,
    name: undefined,
    focus: undefined,
    wakeTriggers: undefined,
    avatarShape: undefined,
    avatarColor: undefined,
  };
}

function systemOneOn(): void {
  setInstanceKeys(storeKeys({ "system-one": { api_key: "ts-key" } }));
}

const NEEDS_SYSTEM_ONE = /the agent-optimized browser needs the System One key under Platform keys/;

afterEach(() => {
  clearInstanceKeys();
});

test("creating an agent on the agent-optimized browser is refused while the System One key is off", async () => {
  clearInstanceKeys();
  await assert.rejects(createAgent(services(), GUILD, OPERATOR, request(OPTIMIZED)), (error: unknown) => {
    assert.ok(error instanceof AgentValidationError);
    assert.match(error.message, NEEDS_SYSTEM_ONE);
    return true;
  });
});

test("creating an agent on the agent-optimized browser is refused while its browser model's provider is not connected", async () => {
  systemOneOn();
  await assert.rejects(
    createAgent(services(), GUILD, OPERATOR, request({ ...OPTIMIZED, browser_model: UNCONNECTED_MODEL })),
    ModelNotConnectedError,
  );
});

test("creating an agent on the agent-optimized browser goes on once the key is on and its browser model connected", async () => {
  systemOneOn();
  await assert.rejects(createAgent(services(), GUILD, OPERATOR, request(OPTIMIZED)), ReachedDatabase);
});

test("creating an agent on the step-by-step browser needs no System One key", async () => {
  clearInstanceKeys();
  await assert.rejects(createAgent(services(), GUILD, OPERATOR, request({ model: MODEL, browser: true })), ReachedDatabase);
});

test("switching an agent to the agent-optimized browser is refused while the System One key is off", async () => {
  clearInstanceKeys();
  await assert.rejects(reconfigureAgent(services(), agentRow(), "user_1", patch(OPTIMIZED)), NEEDS_SYSTEM_ONE);
});

test("switching an agent to the agent-optimized browser is refused while its browser model's provider is not connected", async () => {
  systemOneOn();
  await assert.rejects(
    reconfigureAgent(services(), agentRow(), "user_1", patch({ ...OPTIMIZED, browser_model: UNCONNECTED_MODEL })),
    ModelNotConnectedError,
  );
});

test("switching an agent to the agent-optimized browser goes on once the key is on and its browser model connected", async () => {
  systemOneOn();
  await assert.rejects(reconfigureAgent(services(), agentRow(), "user_1", patch(OPTIMIZED)), ReachedDatabase);
});

/** An agent already on the agent-optimized browser. */
function optimizedAgent() {
  return agentRow({ config: { ...agentRow().config, ...OPTIMIZED } });
}

test("an edit that leaves the agent-optimized browser alone saves while the System One key is off", async () => {
  clearInstanceKeys();
  await assert.rejects(
    reconfigureAgent(services(), optimizedAgent(), "user_1", patch({ ...OPTIMIZED, temperature: 0.5 })),
    ReachedDatabase,
  );
  await assert.rejects(
    reconfigureAgent(services(), optimizedAgent(), "user_1", { ...patch(OPTIMIZED), name: "scout-2" }),
    ReachedDatabase,
  );
});

test("an edit that leaves the agent-optimized browser alone saves while its browser model's provider is not connected", async () => {
  systemOneOn();
  const agent = agentRow({ config: { ...agentRow().config, ...OPTIMIZED, browser_model: UNCONNECTED_MODEL } });
  await assert.rejects(
    reconfigureAgent(services(), agent, "user_1", patch({ ...OPTIMIZED, browser_model: UNCONNECTED_MODEL, temperature: 0.5 })),
    ReachedDatabase,
  );
});

test("changing the agent-optimized browser's model is refused while the System One key is off", async () => {
  clearInstanceKeys();
  await assert.rejects(
    reconfigureAgent(services(), optimizedAgent(), "user_1", patch({ ...OPTIMIZED, browser_model: "openrouter/openai/gpt-5.6-sol" })),
    NEEDS_SYSTEM_ONE,
  );
});
