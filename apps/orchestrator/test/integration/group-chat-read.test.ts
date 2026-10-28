import assert from "node:assert/strict";
import { after, test } from "node:test";
import { buildApp } from "../../src/app.js";
import { connect } from "../../src/seed/connect.js";
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
import { mcpDatabase, McpPool } from "../../src/mcp/index.js";

const OWNER = {
  "X-Guilds-User": "user_operator",
  "X-Guilds-Org": "org_home",
};

const dbName = uniqueDbName("agent_platform_group_read");

after(async () => {
  await dropIsolatedDatabase(dbName);
});

test(
  "each user keeps a seen-through cursor on a guild's group chat",
  { timeout: 60_000 },
  async () => {
    process.env.SECRETS_MASTER_KEY = HEX_MASTER_KEY;
    const databaseUrl = await createIsolatedDatabase(dbName);
    const database = await connect(databaseUrl);
    const notes = new NotesStore(tempDir("guilds-group-read-notes-"), templatesRoot());
    await notes.ensureSystemPrompt();
    const db = database.pool;
    const workspaceRoot = tempDir("guilds-group-read-workspaces-");
    const generation = new GenerationLoop({
      db: generationDatabase(db),
      mcp: new McpPool(mcpDatabase(db)),
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
        userId: "user_teammate_read",
        name: "teammate-read",
        image: null,
        email: "teammate-read@example.com",
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
        payload: { name: "reading-room", visibility: "org" },
      });
      assert.equal(created.statusCode, 201);
      const guildId = String(created.json().id);
      const base = `/api/guilds/${guildId}/group-chat`;

      const fresh = await app.inject({ method: "GET", url: base, headers: OWNER });
      assert.equal(fresh.statusCode, 200);
      assert.equal(fresh.json().seen_through_seq, null);

      for (const content of ["first", "second", "third"]) {
        const posted = await app.inject({
          method: "POST",
          url: `${base}/messages`,
          headers: { ...OWNER, "content-type": "application/json" },
          payload: { content },
        });
        assert.equal(posted.statusCode, 202);
      }

      const poster = await app.inject({ method: "GET", url: base, headers: OWNER });
      assert.equal(poster.json().chat_seq, 3);
      assert.equal(poster.json().seen_through_seq, 3, "a user's own post is never new to them");

      const reader = await app.inject({ method: "GET", url: base, headers: TEAMMATE });
      assert.equal(reader.statusCode, 200);
      assert.equal(reader.json().seen_through_seq, null, "the cursor is per user");

      const mark = async (headers: Record<string, string>, seq: unknown) =>
        app.inject({
          method: "PUT",
          url: `${base}/read`,
          headers: { ...headers, "content-type": "application/json" },
          payload: { seen_through_seq: seq },
        });

      const marked = await mark(TEAMMATE, 2);
      assert.equal(marked.statusCode, 200);
      assert.deepEqual(marked.json(), { seen_through_seq: 2 });

      const backwards = await mark(TEAMMATE, 1);
      assert.deepEqual(backwards.json(), { seen_through_seq: 2 }, "the cursor never moves back");

      const ahead = await mark(TEAMMATE, 40);
      assert.deepEqual(
        ahead.json(),
        { seen_through_seq: 3 },
        "the cursor is clamped to the chat sequence",
      );

      const state = await app.inject({ method: "GET", url: base, headers: TEAMMATE });
      assert.equal(state.json().seen_through_seq, 3);

      for (const bad of [-1, 1.5, "x", null]) {
        const rejected = await mark(TEAMMATE, bad);
        assert.equal(rejected.statusCode, 422, `seen_through_seq=${String(bad)}`);
      }

      const stranger = await insertUser(db, {
          userId: "user_stranger_read",
          name: "stranger-read",
          image: null,
          email: "stranger-read@example.com",
        }, new Date());
      const denied = await mark(
        { "X-Guilds-User": String(stranger.id), "X-Guilds-Org": "org_home" },
        1,
      );
      assert.equal(denied.statusCode, 404);
    } finally {
      await app.close();
      await generation.close();
      await database.close();
    }
  },
);
