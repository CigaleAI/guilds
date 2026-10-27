import assert from "node:assert/strict";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { after, test } from "node:test";
import { buildApp } from "../../src/app.js";
import { connect } from "../../src/db/client.js";
import { insertAgent } from "../../src/db/agents.js";
import { insertMember } from "../../src/db/orgs.js";
import { insertUser } from "../../src/db/users.js";
import { GuildError } from "../../src/guilds/errors.js";
import { removeOperator, setOperatorRole } from "../../src/guilds/operators.js";
import { createGuild, updateGuildSettings, type GuildServices } from "../../src/guilds/service.js";
import { NotesStore } from "../../src/notes/store.js";
import { LimitError, OPEN_POLICY } from "../../src/policy/index.js";
import { scriptDatabase, Scripts } from "../../src/scripts/catalog.js";
import { scheduleDatabase, Schedules } from "../../src/schedules/service.js";
import { HEX_MASTER_KEY, tempDir } from "../helpers/env.js";
import { templatesRoot } from "../helpers/fixtures.js";
import { limitedPolicy } from "../helpers/policy.js";
import { createIsolatedDatabase, dropIsolatedDatabase, uniqueDbName } from "../helpers/postgres.js";

const dbName = uniqueDbName("agent_platform_guild_settings");
const HOME = { id: "org_home", slug: "home" };
const OPERATOR = { id: "user_operator", name: "operator" };

after(async () => {
  await dropIsolatedDatabase(dbName);
});

function refusedWith(status: number, message?: RegExp) {
  return (error: unknown) => {
    assert.ok(error instanceof GuildError, String(error));
    assert.equal(error.status, status);
    if (message) {
      assert.match(error.message, message);
    }
    return true;
  };
}

test("guild settings change within the guild's state and roles", { timeout: 60_000 }, async () => {
  process.env.SECRETS_MASTER_KEY = HEX_MASTER_KEY;
  const database = await connect(await createIsolatedDatabase(dbName));
  const notes = new NotesStore(tempDir("guilds-settings-notes-"), templatesRoot());
  await notes.ensureSystemPrompt();
  const db = database.pool;
  const app = await buildApp(database, {
    db,
    notes,
    scripts: new Scripts(scriptDatabase(db)),
    schedules: new Schedules(scheduleDatabase(db)),
  });
  const released: string[] = [];
  const state = { deleting: false, busy: false };
  const services: GuildServices = {
    db,
    notes,
    policy: OPEN_POLICY,
    schedules: Object.assign(new Schedules(scheduleDatabase(db)), {
      releaseGuild: async (guildId: string) => {
        released.push(guildId);
      },
    }),
    generation: {
      deleting_guild: () => state.deleting,
      agent_is_busy: () => state.busy,
      delete_guild: async () => {},
    },
  };
  const draft = { name: "desk", about: "", description: "", visibility: "org" };

  try {
    const capped = { ...services, policy: limitedPolicy({ maxGuilds: 0 }) };
    await assert.rejects(createGuild(capped, HOME, OPERATOR, draft), LimitError);
    const guild = await createGuild(services, HOME, OPERATOR, draft);
    const chat = await app.inject({
      method: "GET",
      url: `/api/guilds/${guild.id}/group-chat`,
      headers: { "X-Guilds-User": "user_operator", "X-Guilds-Org": "org_home" },
    });
    assert.equal(chat.statusCode, 503, "a box without a generation loop has no group chat");
    await assert.rejects(
      createGuild(services, HOME, OPERATOR, draft),
      refusedWith(409, /already exists/),
    );

    state.deleting = true;
    await assert.rejects(
      updateGuildSettings(services, guild, OPERATOR, { name: "desk-two" }),
      refusedWith(409, /being deleted/),
    );
    state.deleting = false;
    await insertAgent(
      db,
      { agentId: "a_settings", guildId: guild.id, name: "worker", config: {} },
      new Date(),
    );
    state.busy = true;
    await assert.rejects(
      updateGuildSettings(services, guild, OPERATOR, { name: "desk-two" }),
      refusedWith(409, /already generating/),
    );
    const sameName = await updateGuildSettings(services, guild, OPERATOR, {
      name: "desk",
      about: "kept",
    });
    assert.equal(
      sameName.about,
      "kept",
      "keeping the name is no rename, so a busy agent does not block it",
    );
    state.busy = false;

    const guildDir = path.join(notes.root, "orgs", "home", "guilds");
    mkdirSync(path.join(guildDir, "desk-two"), { recursive: true });
    writeFileSync(path.join(guildDir, "desk-two", "taken.md"), "");
    await assert.rejects(updateGuildSettings(services, guild, OPERATOR, { name: "desk-two" }));
    const reverted = await updateGuildSettings(services, guild, OPERATOR, {});
    assert.equal(reverted.name, "desk", "a folder that cannot move puts the old name back");

    const renamed = await updateGuildSettings(services, guild, OPERATOR, { name: "desk-three" });
    assert.equal(renamed.name, "desk-three");
    assert.ok(existsSync(path.join(guildDir, "desk-three")));

    await updateGuildSettings(services, renamed, OPERATOR, { routinesEnabled: false });
    assert.deepEqual(released, []);
    const paused = await updateGuildSettings(services, renamed, OPERATOR, {});
    await updateGuildSettings(services, paused, OPERATOR, { routinesEnabled: true });
    assert.deepEqual(released, [guild.id], "switching routines on releases the held schedules");

    const member = await insertUser(
      db,
      { userId: "user_settings_member", name: "settings-member" },
      new Date(),
    );
    await insertMember(db, "org_home", member.id, "member", new Date());
    const asMember = { id: member.id, name: member.name };
    await setOperatorRole(db, renamed, member.id, "operator");
    await assert.rejects(
      updateGuildSettings(services, renamed, asMember, { visibility: "private" }),
      refusedWith(403),
    );
    const kept = await updateGuildSettings(services, renamed, asMember, {
      visibility: "org",
      about: "by an operator",
    });
    assert.equal(kept.about, "by an operator", "an unchanged visibility needs no admin");

    const outsider = await insertUser(
      db,
      { userId: "user_settings_outsider", name: "settings-outsider" },
      new Date(),
    );
    await assert.rejects(
      setOperatorRole(db, renamed, outsider.id, "operator"),
      refusedWith(422, /members of the organisation/),
    );
    await assert.rejects(
      removeOperator(db, renamed, outsider.id),
      refusedWith(404, /operator not found/),
    );
    await assert.rejects(removeOperator(db, kept, "user_operator"), refusedWith(409));
  } finally {
    await app.close();
    await database.close();
  }
});
