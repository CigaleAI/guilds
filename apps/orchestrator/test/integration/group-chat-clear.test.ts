import assert from "node:assert/strict";
import { after, test } from "node:test";
import { buildApp } from "../../src/app.js";
import { connect } from "../../src/db/client.js";
import { GroupChatCleared } from "../../src/db/errors.js";
import { Repositories } from "../../src/db/repositories.js";
import { GenerationLoop } from "../../src/generation/index.js";
import { NotesStore } from "../../src/notes/store.js";
import { Scripts } from "../../src/scripts/catalog.js";
import { Schedules } from "../../src/schedules/service.js";
import { HEX_MASTER_KEY, tempDir } from "../helpers/env.js";
import { templatesRoot } from "../helpers/fixtures.js";
import { ExportSandboxes } from "../helpers/live.js";
import { createIsolatedDatabase, dropIsolatedDatabase, uniqueDbName } from "../helpers/postgres.js";

const OWNER = {
  "X-Guilds-User": "user_operator",
  "X-Guilds-Org": "org_home",
};

const HASHES = { systemPromptHash: "s", taskPromptHash: "t", memoryPromptHash: "m" };

const dbName = uniqueDbName("agent_platform_group_clear");

after(async () => {
  await dropIsolatedDatabase(dbName);
});

test(
  "a guild admin clears the group chat while the sequence keeps counting",
  { timeout: 60_000 },
  async () => {
    process.env.SECRETS_MASTER_KEY = HEX_MASTER_KEY;
    const databaseUrl = await createIsolatedDatabase(dbName);
    const database = await connect(databaseUrl);
    const notes = new NotesStore(tempDir("guilds-group-clear-notes-"), templatesRoot(), "notes");
    await notes.ensureSystemPrompt();
    const repo = new Repositories(database.pool);
    const workspaceRoot = tempDir("guilds-group-clear-workspaces-");
    const generation = new GenerationLoop(
      repo,
      notes,
      workspaceRoot,
      new ExportSandboxes(workspaceRoot),
    );
    const app = await buildApp(database, {
      repo,
      notes,
      scripts: new Scripts(repo),
      schedules: new Schedules(repo, notes),
      generation,
    });

    const teammate = await repo.insertUser(
      "user_teammate_clear",
      "teammate-clear",
      new Date(),
      null,
      "teammate-clear@example.com",
    );
    await repo.insertMember("org_home", String(teammate.id), "member", new Date());
    const TEAMMATE = {
      "X-Guilds-User": String(teammate.id),
      "X-Guilds-Org": "org_home",
    };

    try {
      const created = await app.inject({
        method: "POST",
        url: "/api/guilds",
        headers: { ...OWNER, "content-type": "application/json" },
        payload: { name: "clearing-room", visibility: "org" },
      });
      assert.equal(created.statusCode, 201);
      const guildId = String(created.json().id);
      const base = `/api/guilds/${guildId}/group-chat`;

      const started = new Date(Date.now() - 60_000);
      await repo.insertAgent("a_clear", guildId, "scout", {}, started);
      await repo.createRun("r_before", "a_clear", {}, "sys", "task", null, started, HASHES);
      await repo.postUserGroupMessage(guildId, "first", [], [], [], started);
      await repo.postAgentGroupMessage(
        guildId,
        "a_clear",
        "scout",
        "r_before",
        "second",
        [],
        [],
        [],
        started,
      );
      await repo.postUserGroupMessage(guildId, "third", [], [], [], started);
      await repo.markGroupChatSeen(guildId, "user_operator", 2, started);

      const denied = await app.inject({
        method: "DELETE",
        url: `${base}/messages`,
        headers: TEAMMATE,
      });
      assert.equal(denied.statusCode, 403, "only a guild admin clears the chat");

      const cleared = await app.inject({
        method: "DELETE",
        url: `${base}/messages`,
        headers: OWNER,
      });
      assert.equal(cleared.statusCode, 200);
      assert.equal(cleared.json().chat_seq, 3);
      assert.equal(cleared.json().pending_agent_count, 0);
      assert.equal(cleared.json().agent_message_count, 0);

      const listed = await app.inject({ method: "GET", url: `${base}/messages`, headers: OWNER });
      assert.deepEqual(listed.json(), []);
      const state = await app.inject({ method: "GET", url: base, headers: OWNER });
      assert.equal(state.json().seen_through_seq, 2, "read cursors stay where they were");

      await assert.rejects(
        () =>
          repo.postAgentGroupMessage(
            guildId,
            "a_clear",
            "scout",
            "r_before",
            "stale",
            [],
            [],
            [],
            new Date(),
          ),
        GroupChatCleared,
      );
      await repo.createRun("r_after", "a_clear", {}, "sys", "task", null, new Date(), HASHES);
      const fresh = await repo.postAgentGroupMessage(
        guildId,
        "a_clear",
        "scout",
        "r_after",
        "fresh",
        [],
        [],
        [],
        new Date(),
      );
      assert.equal(Number(fresh?.seq), 4, "the next message continues the sequence");
    } finally {
      await app.close();
      await generation.close();
      await database.close();
    }
  },
);
