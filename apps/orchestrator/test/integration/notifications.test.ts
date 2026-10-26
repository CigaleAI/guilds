import assert from "node:assert/strict";
import { after, test } from "node:test";
import { buildApp } from "../../src/app.js";
import { connect } from "../../src/db/client.js";
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

const dbName = uniqueDbName("agent_platform_notifications");

after(async () => {
  await dropIsolatedDatabase(dbName);
});

test("an operator's inbox holds open issues and unread tags from the guilds they operate", { timeout: 60_000 }, async () => {
  process.env.SECRETS_MASTER_KEY = HEX_MASTER_KEY;
  const databaseUrl = await createIsolatedDatabase(dbName);
  const database = await connect(databaseUrl);
  const notes = new NotesStore(tempDir("guilds-notifications-notes-"), templatesRoot());
  await notes.ensureSystemPrompt();
  const repo = new Repositories(database.pool);
  const workspaceRoot = tempDir("guilds-notifications-workspaces-");
  const generation = new GenerationLoop(repo, notes, workspaceRoot, new ExportSandboxes(workspaceRoot));
  const app = await buildApp(database, {
    repo,
    notes,
    scripts: new Scripts(repo),
    schedules: new Schedules(repo),
    generation,
  });

  const teammate = await repo.insertUser(
    {
      userId: "user_teammate_inbox",
      name: "teammate-inbox",
      image: null,
      email: "teammate-inbox@example.com",
    },
    new Date(),
  );
  await repo.insertMember("org_home", String(teammate.id), "member", new Date());
  const bystander = await repo.insertUser(
    {
      userId: "user_bystander_inbox",
      name: "bystander-inbox",
      image: null,
      email: "bystander-inbox@example.com",
    },
    new Date(),
  );
  await repo.insertMember("org_home", String(bystander.id), "member", new Date());
  const TEAMMATE = { "X-Guilds-User": String(teammate.id), "X-Guilds-Org": "org_home" };
  const BYSTANDER = { "X-Guilds-User": String(bystander.id), "X-Guilds-Org": "org_home" };
  const json = { "content-type": "application/json" };
  const inbox = async (headers: Record<string, string>) => {
    const response = await app.inject({ method: "GET", url: "/api/notifications", headers });
    assert.equal(response.statusCode, 200, response.body);
    return response.json() as {
      issues: Array<{ id: string; guild_name: string; summary: string }>;
      mentions: Array<{ seq: number; guild_name: string; author_name: string; content: string }>;
      unread: Array<{ guild_id: string; count: number }>;
    };
  };

  try {
    const created = await app.inject({
      method: "POST",
      url: "/api/guilds",
      headers: { ...OWNER, ...json },
      payload: { name: "watch-room", visibility: "org" },
    });
    assert.equal(created.statusCode, 201);
    const guildId = String(created.json().id);
    const added = await app.inject({
      method: "PUT",
      url: `/api/guilds/${guildId}/operators/${String(teammate.id)}`,
      headers: { ...OWNER, ...json },
      payload: { role: "operator" },
    });
    assert.equal(added.statusCode, 200, added.body);

    const post = async (content: string) => {
      const response = await app.inject({
        method: "POST",
        url: `/api/guilds/${guildId}/group-chat/messages`,
        headers: { ...OWNER, ...json },
        payload: { content },
      });
      assert.equal(response.statusCode, 202, response.body);
      return response.json() as { seq: number; tagged: string[]; tagged_user_ids: string[] };
    };

    const named = await post("@teammate-inbox can you check the feed?");
    assert.deepEqual(named.tagged, ["teammate-inbox"]);
    assert.deepEqual(named.tagged_user_ids, [String(teammate.id)]);
    const everyone = await post("@user heads-up, the digest is late");
    assert.deepEqual(everyone.tagged, ["user"]);
    assert.deepEqual([...everyone.tagged_user_ids].sort(), [String(teammate.id), "user_operator"].sort());
    const notAnOperator = await post("@bystander-inbox is not an operator here");
    assert.deepEqual(notAnOperator.tagged_user_ids, []);

    const teammateInbox = await inbox(TEAMMATE);
    assert.deepEqual(
      teammateInbox.mentions.map((row) => [row.seq, row.guild_name, row.author_name]),
      [
        [everyone.seq, "watch-room", "operator"],
        [named.seq, "watch-room", "operator"],
      ],
    );
    assert.deepEqual(teammateInbox.unread, [{ guild_id: guildId, count: 3 }]);
    const ownerInbox = await inbox(OWNER);
    assert.deepEqual(ownerInbox.mentions, [], "posting reads your own chat");
    assert.deepEqual(ownerInbox.unread, [], "and leaves nothing unread");
    const bystanderInbox = await inbox(BYSTANDER);
    assert.deepEqual(bystanderInbox.mentions, []);
    assert.deepEqual(
      bystanderInbox.unread,
      [{ guild_id: guildId, count: 3 }],
      "an org-visible guild counts unread for every member, operator or not",
    );

    const readFirst = await app.inject({
      method: "PUT",
      url: `/api/guilds/${guildId}/group-chat/read`,
      headers: { ...TEAMMATE, ...json },
      payload: { seen_through_seq: named.seq },
    });
    assert.equal(readFirst.statusCode, 200);
    const readOne = await inbox(TEAMMATE);
    assert.deepEqual(
      readOne.mentions.map((row) => row.seq),
      [everyone.seq],
    );
    assert.deepEqual(readOne.unread, [{ guild_id: guildId, count: 2 }]);
    await app.inject({
      method: "PUT",
      url: `/api/guilds/${guildId}/group-chat/read`,
      headers: { ...TEAMMATE, ...json },
      payload: { seen_through_seq: notAnOperator.seq },
    });
    const readAll = await inbox(TEAMMATE);
    assert.deepEqual(readAll.mentions, []);
    assert.deepEqual(readAll.unread, [], "a chat read to its end is not unread");

    const taggedAgain = await post("@teammate-inbox ping");
    const followUp = await post("no tag here");
    const taggedInbox = await inbox(TEAMMATE);
    assert.deepEqual(
      taggedInbox.mentions.map((row) => row.seq),
      [taggedAgain.seq],
    );
    assert.deepEqual(taggedInbox.unread, [{ guild_id: guildId, count: 2 }], "an untagged message is unread too");
    const marked = await app.inject({
      method: "POST",
      url: "/api/notifications/read",
      headers: TEAMMATE,
    });
    assert.equal(marked.statusCode, 200, marked.body);
    assert.deepEqual(marked.json().mentions, []);
    assert.deepEqual(marked.json().unread, [], "marking tags read reads the whole tagged chat");
    assert.deepEqual((await inbox(TEAMMATE)).mentions, []);
    const chat = await app.inject({
      method: "GET",
      url: `/api/guilds/${guildId}/group-chat`,
      headers: TEAMMATE,
    });
    assert.equal(chat.statusCode, 200, chat.body);
    assert.equal(chat.json().seen_through_seq, followUp.seq, "the tagged chat is read through now");
    assert.deepEqual((await inbox(OWNER)).mentions, [], "another operator's cursor is unchanged");

    const issue = await repo.insertIssue(
      {
        issueId: "iss_inbox",
        guildId,
        orgId: "org_home",
        agentId: null,
        agentName: "scout",
        runId: null,
        kind: "api",
        severity: "high",
        summary: "Feed login expired",
        detail: "401 from the feed API",
        toolName: "feed_fetch",
      },
      new Date(),
    );
    const withIssue = await inbox(TEAMMATE);
    assert.deepEqual(
      withIssue.issues.map((row) => [row.id, row.guild_name, row.summary]),
      [[issue.id, "watch-room", "Feed login expired"]],
    );
    assert.equal((await inbox(OWNER)).issues.length, 1);
    assert.deepEqual((await inbox(BYSTANDER)).issues, [], "only operators get a guild's issues");
    const stillOpen = await app.inject({
      method: "POST",
      url: "/api/notifications/read",
      headers: TEAMMATE,
    });
    assert.equal(stillOpen.statusCode, 200, stillOpen.body);
    assert.equal(stillOpen.json().issues.length, 1, "marking tags as read leaves issues open");

    const resolved = await app.inject({
      method: "PATCH",
      url: `/api/guilds/${guildId}/issues/${String(issue.id)}`,
      headers: { ...TEAMMATE, ...json },
      payload: { status: "resolved" },
    });
    assert.equal(resolved.statusCode, 200);
    assert.deepEqual((await inbox(TEAMMATE)).issues, []);
    assert.deepEqual((await inbox(OWNER)).issues, [], "resolving clears the issue for every operator");
  } finally {
    await app.close();
    await generation.close();
    await database.close();
  }
});
