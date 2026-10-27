import assert from "node:assert/strict";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { after, test } from "node:test";
import { buildApp } from "../../src/app.js";
import { AgentError } from "../../src/agents/errors.js";
import {
  createAgent,
  deleteAgent,
  moveAgentToMachine,
  reconfigureAgent,
  type AgentServices,
  type AgentSettingsPatch,
} from "../../src/agents/service.js";
import { AgentValidationError } from "../../src/agents/validation.js";
import { operatorActor } from "../../src/artifacts/index.js";
import { connect } from "../../src/db/client.js";
import type { GuildRow } from "../../src/db/guilds.js";
import { createGuild } from "../../src/guilds/service.js";
import { NotesStore } from "../../src/notes/store.js";
import { OPEN_POLICY } from "../../src/policy/index.js";
import { scriptDatabase, Scripts } from "../../src/scripts/catalog.js";
import { scheduleDatabase, Schedules } from "../../src/schedules/service.js";
import { HEX_MASTER_KEY, tempDir } from "../helpers/env.js";
import { templatesRoot } from "../helpers/fixtures.js";
import { TEST_CREDENTIALS, TEST_MODEL } from "../helpers/models.js";
import { createIsolatedDatabase, dropIsolatedDatabase, uniqueDbName } from "../helpers/postgres.js";

const dbName = uniqueDbName("agent_platform_agent_settings");
const AUTH = { "X-Guilds-User": "user_operator", "X-Guilds-Org": "org_home" };
const OPERATOR = operatorActor({
  orgId: "org_home",
  actorId: "user_operator",
  actorName: "operator",
});

after(async () => {
  await dropIsolatedDatabase(dbName);
});

function refusedWith(status: number, message?: RegExp) {
  return (error: unknown) => {
    assert.ok(error instanceof AgentError, String(error));
    assert.equal(error.status, status);
    if (message) {
      assert.match(error.message, message);
    }
    return true;
  };
}

test(
  "an agent's settings change within its guild's state, its machine and its notes",
  { timeout: 60_000 },
  async () => {
    process.env.SECRETS_MASTER_KEY = HEX_MASTER_KEY;
    const database = await connect(await createIsolatedDatabase(dbName));
    const notes = new NotesStore(tempDir("guilds-agent-settings-"), templatesRoot());
    await notes.ensureSystemPrompt();
    const db = database.pool;
    const schedules = new Schedules(scheduleDatabase(db));
    const app = await buildApp(database, {
      db,
      notes,
      scripts: new Scripts(scriptDatabase(db)),
      schedules,
    });
    const state = { deleting: false, busy: false };
    const calls: string[] = [];
    const services: AgentServices = {
      db,
      notes,
      artifacts: null,
      policy: OPEN_POLICY,
      modelCredentials: TEST_CREDENTIALS,
      generation: {
        isDeletingGuild: () => state.deleting,
        isAgentBusy: () => state.busy,
        deleteAgent: async (agentId) => {
          calls.push(`delete ${agentId}`);
        },
        machines: {
          moveAgent: async (agentId, machineId) => {
            calls.push(`move ${agentId} ${machineId}`);
          },
          agentBrowserChanged: async (agentId) => {
            calls.push(`browser ${agentId}`);
          },
        },
      },
    };
    const draft = {
      name: "scout",
      focus: "",
      wakeTriggers: "",
      avatarShape: undefined,
      avatarColor: undefined,
      config: { model: TEST_MODEL, browser: true },
      machineId: undefined,
    };
    const unchanged: AgentSettingsPatch = {
      config: { model: TEST_MODEL, browser: true },
      machineId: undefined,
      name: undefined,
      focus: undefined,
      wakeTriggers: undefined,
      avatarShape: undefined,
      avatarColor: undefined,
    };

    try {
      const guildServices = { db, notes, policy: OPEN_POLICY, schedules, generation: null };
      const owner = { id: "user_operator", name: "operator" };
      const guildDraft = { name: "scouts", about: "", description: "", visibility: "org" };
      const guild: GuildRow = await createGuild(
        guildServices,
        { id: "org_home", slug: "home" },
        owner,
        guildDraft,
      );

      state.deleting = true;
      await assert.rejects(
        createAgent(services, guild, OPERATOR, draft),
        refusedWith(409, /being deleted/),
      );
      state.deleting = false;
      await assert.rejects(
        createAgent(services, guild, OPERATOR, { ...draft, config: "browser" }),
        AgentValidationError,
      );
      const agent = await createAgent(services, guild, OPERATOR, draft);
      await assert.rejects(
        createAgent(services, guild, OPERATOR, draft),
        refusedWith(409, /already/),
      );
      const other = await createAgent(services, guild, OPERATOR, { ...draft, name: "ranger" });

      state.busy = true;
      await assert.rejects(
        reconfigureAgent(services, agent, "user_operator", { ...unchanged, name: "scout-two" }),
        refusedWith(409, /generating/),
      );
      state.busy = false;
      state.deleting = true;
      await assert.rejects(
        reconfigureAgent(services, agent, "user_operator", { ...unchanged, name: "scout-two" }),
        refusedWith(409, /being deleted/),
      );
      state.deleting = false;
      await assert.rejects(
        reconfigureAgent(services, agent, "user_operator", { ...unchanged, name: "ranger" }),
        refusedWith(409),
      );

      const agentsDir = path.join(notes.root, "orgs", "home", "guilds", "scouts", "agents");
      mkdirSync(path.join(agentsDir, "scout-two"), { recursive: true });
      writeFileSync(path.join(agentsDir, "scout-two", "taken.md"), "");
      await assert.rejects(
        reconfigureAgent(services, agent, "user_operator", { ...unchanged, name: "scout-two" }),
      );
      const kept = await reconfigureAgent(services, agent, "user_operator", unchanged);
      assert.equal(kept.name, "scout", "a folder that cannot move puts the old name back");
      const renamed = await reconfigureAgent(services, agent, "user_operator", {
        ...unchanged,
        name: "scout-three",
      });
      assert.equal(renamed.name, "scout-three");
      assert.ok(existsSync(path.join(agentsDir, "scout-three")));
      assert.deepEqual(
        calls,
        [],
        "an agent that keeps its machine and browser is neither moved nor restarted",
      );

      await reconfigureAgent(services, renamed, "user_operator", {
        ...unchanged,
        config: { model: TEST_MODEL, browser: false },
      });
      assert.deepEqual(calls, [`browser ${agent.id}`], "a browser switched off restarts");

      const machine = await app.inject({
        method: "POST",
        url: "/api/orgs/org_home/machines",
        headers: { ...AUTH, "content-type": "application/json" },
        payload: { name: "second", box: "standard" },
      });
      assert.equal(machine.statusCode, 201, machine.body);
      const secondId = String(machine.json().id);
      calls.length = 0;
      await assert.rejects(
        reconfigureAgent(services, other, "user_operator", {
          ...unchanged,
          name: "scout-three",
          machineId: secondId,
        }),
        refusedWith(409),
      );
      assert.deepEqual(
        calls,
        [`move ${other.id} ${secondId}`, `move ${other.id} ${other.machine_id}`],
        "a write that fails moves the agent back",
      );

      await assert.rejects(
        moveAgentToMachine(services, other, "user_operator", undefined),
        refusedWith(422, /required/),
      );
      calls.length = 0;
      await moveAgentToMachine(services, other, "user_operator", other.machine_id);
      assert.deepEqual(calls, [], "the agent's own machine is no move");
      await moveAgentToMachine(services, other, "user_operator", secondId);
      assert.deepEqual(calls, [`move ${other.id} ${secondId}`]);

      await assert.rejects(deleteAgent({ ...services, generation: null }, other), refusedWith(503));
      await deleteAgent(services, other);
      assert.equal(calls.at(-1), `delete ${other.id}`);
    } finally {
      await app.close();
      await database.close();
    }
  },
);
