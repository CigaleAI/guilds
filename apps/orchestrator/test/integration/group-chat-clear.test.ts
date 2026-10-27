import assert from "node:assert/strict";
import { after, test } from "node:test";
import { buildApp } from "../../src/app.js";
import { connect } from "../../src/seed/connect.js";
import { GroupChatCleared } from "../../src/db/errors.js";
import { generationDatabase, GenerationLoop } from "../../src/generation/index.js";
import { NotesStore } from "../../src/notes/store.js";
import { scriptDatabase, Scripts } from "../../src/scripts/catalog.js";
import { scheduleDatabase, Schedules } from "../../src/schedules/service.js";
import { HEX_MASTER_KEY, tempDir } from "../helpers/env.js";
import { templatesRoot } from "../helpers/fixtures.js";
import { ExportSandboxes } from "../helpers/live.js";
import { createIsolatedDatabase, dropIsolatedDatabase, uniqueDbName } from "../helpers/postgres.js";
import { insertUser } from "../../src/db/users.js";
import { insertMember } from "../../src/db/orgs.js";
import { insertAgent } from "../../src/db/agents.js";
import { createRun } from "../../src/db/runs.js";
import {
  markGroupChatSeen,
  postAgentGroupMessage,
  postUserGroupMessage,
} from "../../src/db/group-chat.js";

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
    const notes = new NotesStore(tempDir("guilds-group-clear-notes-"), templatesRoot());
    await notes.ensureSystemPrompt();
    const db = database.pool;
    const workspaceRoot = tempDir("guilds-group-clear-workspaces-");
    const generation = new GenerationLoop({
      db: generationDatabase(db),
      notes,
      workspaceRoot,
      sandboxes: new ExportSandboxes(workspaceRoot),
    });
    const app = await buildApp(database, {
      db,
      notes,
      scripts: new Scripts(scriptDatabase(db)),
      schedules: new Schedules(scheduleDatabase(db)),
      generation,
    });

    const teammate = await insertUser(db, {
        userId: "user_teammate_clear",
        name: "teammate-clear",
        image: null,
        email: "teammate-clear@example.com",
      }, new Date());
    await insertMember(db, "org_home", String(teammate.id), "member", new Date());
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
      await insertAgent(db, { agentId: "a_clear", guildId, name: "scout", config: {} }, started);
      await createRun(db,
        {
          runId: "r_before",
          agentId: "a_clear",
          configSnapshot: {},
          systemContent: "sys",
          taskContent: "task",
          userContent: null,
          ...HASHES,
        },
        started,
      );
      await postUserGroupMessage(db,
        { guildId, content: "first", taggedNames: [], taggedAgentIds: [], taggedUserIds: [] },
        started,
      );
      await postAgentGroupMessage(db,
        {
          guildId,
          agentId: "a_clear",
          authorName: "scout",
          sourceRunId: "r_before",
          content: "second",
          taggedNames: [],
          taggedAgentIds: [],
          taggedUserIds: [],
        },
        started,
      );
      await postUserGroupMessage(db,
        { guildId, content: "third", taggedNames: [], taggedAgentIds: [], taggedUserIds: [] },
        started,
      );
      await markGroupChatSeen(db, guildId, "user_operator", 2, started);

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
          postAgentGroupMessage(db,
            {
              guildId,
              agentId: "a_clear",
              authorName: "scout",
              sourceRunId: "r_before",
              content: "stale",
              taggedNames: [],
              taggedAgentIds: [],
              taggedUserIds: [],
            },
            new Date(),
          ),
        GroupChatCleared,
      );
      await createRun(db,
        {
          runId: "r_after",
          agentId: "a_clear",
          configSnapshot: {},
          systemContent: "sys",
          taskContent: "task",
          userContent: null,
          ...HASHES,
        },
        new Date(),
      );
      const fresh = await postAgentGroupMessage(db,
        {
          guildId,
          agentId: "a_clear",
          authorName: "scout",
          sourceRunId: "r_after",
          content: "fresh",
          taggedNames: [],
          taggedAgentIds: [],
          taggedUserIds: [],
        },
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
