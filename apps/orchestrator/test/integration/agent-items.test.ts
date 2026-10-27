import assert from "node:assert/strict";
import { after, test } from "node:test";
import { buildApp } from "../../src/app.js";
import { connect } from "../../src/db/client.js";
import { insertAgent } from "../../src/db/agents.js";
import { insertGuild } from "../../src/db/guilds.js";
import { insertIssue } from "../../src/db/issues.js";
import { insertRun } from "../../src/db/runs.js";
import { NotesStore } from "../../src/notes/store.js";
import { scriptDatabase, Scripts } from "../../src/scripts/catalog.js";
import { scheduleDatabase, Schedules } from "../../src/schedules/service.js";
import { HEX_MASTER_KEY, tempDir } from "../helpers/env.js";
import { templatesRoot } from "../helpers/fixtures.js";
import { createIsolatedDatabase, dropIsolatedDatabase, uniqueDbName } from "../helpers/postgres.js";

const OWNER = { "X-Guilds-User": "user_operator", "X-Guilds-Org": "org_home" };
const JSON_OWNER = { ...OWNER, "content-type": "application/json" };

const dbName = uniqueDbName("agent_platform_agent_items");

after(async () => {
  await dropIsolatedDatabase(dbName);
});

test(
  "an agent's scripts and routines and a guild's issues answer for what is not there",
  { timeout: 60_000 },
  async () => {
    process.env.SECRETS_MASTER_KEY = HEX_MASTER_KEY;
    const database = await connect(await createIsolatedDatabase(dbName));
    const notes = new NotesStore(tempDir("guilds-agent-items-"), templatesRoot());
    await notes.ensureSystemPrompt();
    const db = database.pool;
    const app = await buildApp(database, {
      db,
      notes,
      scripts: new Scripts(scriptDatabase(db)),
      schedules: new Schedules(scheduleDatabase(db)),
    });
    await insertGuild(
      db,
      { guildId: "guild_items", name: "items-desk", orgId: "org_home" },
      new Date(),
    );
    await insertAgent(
      db,
      { agentId: "a_items", guildId: "guild_items", name: "keeper", config: {} },
      new Date(),
    );
    const agent = "/api/agents/a_items";
    const guild = "/api/guilds/guild_items";

    try {
      const script = { name: "tally", description: "Counts.", source: "print(1)\n" };
      for (const name of ["tally", "sum"]) {
        const created = await app.inject({
          method: "POST",
          url: `${agent}/scripts`,
          headers: JSON_OWNER,
          payload: { ...script, name },
        });
        assert.equal(created.statusCode, 201, created.body);
      }
      const listed = await app.inject({ method: "GET", url: `${agent}/scripts`, headers: OWNER });
      assert.deepEqual(
        listed
          .json()
          .map((row: { name: string; display_path: string }) => [
            row.name,
            row.display_path.endsWith(`/scripts/${row.name}`),
          ]),
        [
          ["sum", true],
          ["tally", true],
        ],
      );
      assert.equal(
        (await app.inject({ method: "DELETE", url: `${agent}/scripts/tally`, headers: OWNER }))
          .statusCode,
        204,
      );
      assert.equal(
        (await app.inject({ method: "GET", url: `${agent}/scripts/tally`, headers: OWNER }))
          .statusCode,
        404,
      );
      assert.equal(
        (await app.inject({ method: "DELETE", url: `${agent}/scripts/tally`, headers: OWNER }))
          .statusCode,
        404,
      );
      assert.equal(
        (await app.inject({ method: "DELETE", url: `${agent}/scripts`, headers: OWNER }))
          .statusCode,
        204,
      );
      assert.deepEqual(
        (await app.inject({ method: "GET", url: `${agent}/scripts`, headers: OWNER })).json(),
        [],
      );

      const patched = await app.inject({
        method: "PATCH",
        url: `${agent}/schedules/sch_missing`,
        headers: JSON_OWNER,
        payload: { paused: true },
      });
      assert.equal(patched.statusCode, 404);
      assert.equal(
        (
          await app.inject({
            method: "DELETE",
            url: `${agent}/schedules/sch_missing`,
            headers: OWNER,
          })
        ).statusCode,
        404,
      );

      assert.equal(
        (await app.inject({ method: "GET", url: `${guild}/issues?status=closed`, headers: OWNER }))
          .statusCode,
        422,
      );
      assert.deepEqual(
        (
          await app.inject({ method: "POST", url: `${guild}/issues/resolve`, headers: OWNER })
        ).json(),
        { resolved: 0 },
      );
      const issue = await insertIssue(
        db,
        {
          issueId: "iss_items",
          guildId: "guild_items",
          orgId: "org_home",
          agentId: "a_items",
          agentName: "keeper",
          runId: null,
          kind: "other",
          severity: "low",
          summary: "Odd.",
          detail: "",
          toolName: null,
        },
        new Date(),
      );
      const unsaid = await app.inject({
        method: "PATCH",
        url: `${guild}/issues/${issue.id}`,
        headers: JSON_OWNER,
        payload: {},
      });
      assert.equal(unsaid.statusCode, 422);
      const missing = await app.inject({
        method: "PATCH",
        url: `${guild}/issues/iss_missing`,
        headers: JSON_OWNER,
        payload: { status: "resolved" },
      });
      assert.equal(missing.statusCode, 404);
      const resolved = await app.inject({
        method: "PATCH",
        url: `${guild}/issues/${issue.id}`,
        headers: JSON_OWNER,
        payload: { status: "resolved" },
      });
      assert.equal(resolved.statusCode, 200, resolved.body);
      assert.equal(resolved.json().status, "resolved");

      const runs = `${agent}/runs`;
      const start = (payload: object) =>
        app.inject({ method: "POST", url: runs, headers: JSON_OWNER, payload });
      assert.equal((await start({ message: "  " })).statusCode, 422, "an empty message");
      assert.equal(
        (await start({ attachment_ids: "att_1" })).statusCode,
        422,
        "ids that are not a list",
      );
      assert.equal((await start({ attachment_ids: [" "] })).statusCode, 422, "a blank id");
      const images = await start({ attachment_ids: ["att_1"] });
      assert.equal(images.statusCode, 503, "a box without an image store takes no images");
      assert.match(String(images.json().detail), /attachments/);
      const queued = await start({ message: "hello" });
      assert.equal(queued.statusCode, 503, "a box without a generation loop opens no run");
      assert.match(String(queued.json().detail), /generation/);

      await insertRun(
        db,
        {
          runId: "run_items",
          agentId: "a_items",
          kind: "direct",
          configSnapshot: {},
          systemContent: "",
          taskContent: "",
          opening: [],
          systemPromptHash: "",
          taskPromptHash: "",
          memoryPromptHash: "",
        },
        new Date(),
      );
      const say = (payload: object) =>
        app.inject({
          method: "POST",
          url: "/api/runs/run_items/messages",
          headers: JSON_OWNER,
          payload,
        });
      assert.equal((await say({})).statusCode, 422, "a message needs content or images");
      assert.equal((await say({ content: " " })).statusCode, 422, "blank content");
      assert.equal((await say({ content: "more" })).statusCode, 503);
      const messages = await app.inject({
        method: "GET",
        url: "/api/runs/run_items/messages",
        headers: OWNER,
      });
      assert.equal(messages.statusCode, 200, messages.body);
    } finally {
      await app.close();
      await database.close();
    }
  },
);
