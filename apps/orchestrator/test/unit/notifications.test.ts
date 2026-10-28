import assert from "node:assert/strict";
import { test } from "node:test";
import {
  NOTICE_PREVIEW_LENGTH,
  NOTIFICATIONS_CHANGED,
  NOTIFICATIONS_MESSAGE,
  Notifications,
  messageNotice,
  type NotificationsDatabase,
} from "../../src/notifications/index.js";

type Operator = { user_id: string; name: string; role: string };

/** The inbox's db functions with the rows a test hands back, which are partial. */
type FakeInbox = {
  [K in keyof NotificationsDatabase]: (...args: Parameters<NotificationsDatabase[K]>) => Promise<unknown>;
};

function hub(
  operators: Operator[],
  extras: Partial<FakeInbox> = {},
  viewers: string[] = operators.map((operator) => operator.user_id),
): Notifications {
  const db: FakeInbox = {
    async getAgent(agentId) {
      return agentId === "agent_scout" ? scout : null;
    },
    async getGuild(guildId) {
      return guildId === "guild_1" ? { id: guildId, org_id: "org_1", operators } : null;
    },
    async listGuildViewerIds(guildId) {
      return guildId === "guild_1" ? viewers : [];
    },
    async listInboxIssues() {
      return [];
    },
    async listInboxMentions() {
      return [];
    },
    async listUnreadGroupChats() {
      return [];
    },
    async markInboxMentionsRead() {
      return [];
    },
    ...extras,
  };
  return new Notifications(db as never);
}

const scout = {
  id: "agent_scout",
  name: "scout",
  avatar_shape: "clay:scout",
  avatar_color: "#1d9bf0",
  config: { model: "x" },
};

const message = {
  guild_id: "guild_1",
  seq: 7,
  author_type: "agent",
  author_name: "scout",
  author_agent_id: "agent_scout",
  content: "the feed is back",
  tagged_user_ids: ["user_ada"],
};

const notice = {
  guild_id: "guild_1",
  seq: 7,
  author_type: "agent",
  author_name: "scout",
  preview: "the feed is back",
  agent: { id: "agent_scout", name: "scout", avatar_shape: "clay:scout", avatar_color: "#1d9bf0" },
};

test("a committed message reaches every viewer of the guild, on the streams opened in its organisation", async () => {
  const notifications = hub([], {}, ["user_ada", "user_bo"]);
  const ada = notifications.subscribe("user_ada", "org_1");
  const adaElsewhere = notifications.subscribe("user_ada", "org_2");
  const bo = notifications.subscribe("user_bo", "org_1");
  const cy = notifications.subscribe("user_cy", "org_1");
  await notifications.observe("guild_1", "group.message.committed", message);
  assert.equal(ada.size, 1);
  assert.equal(adaElsewhere.size, 0, "a stream opened in another organisation hears nothing");
  assert.equal(bo.size, 1, "a viewer the message does not tag still hears of it");
  assert.equal(cy.size, 0, "someone who cannot see the guild hears nothing");
  assert.deepEqual(await ada.get(), [NOTIFICATIONS_MESSAGE, notice]);
});

test("a message notice carries the start of the message and the author agent's look", () => {
  assert.deepEqual(messageNotice(message, scout), notice);
  const long = messageNotice({ ...message, content: "x".repeat(NOTICE_PREVIEW_LENGTH + 50) }, scout);
  assert.equal(String(long.preview).length, NOTICE_PREVIEW_LENGTH);
  const bare = messageNotice(message, { id: "agent_scout", name: "", avatar_shape: null, avatar_color: null });
  assert.deepEqual(bare.agent, { id: "agent_scout", name: "", avatar_shape: "teardrop", avatar_color: "#7c5cff" });
});

test("an operator's message has no agent, and an empty one no preview", () => {
  const theirs = messageNotice({ guild_id: "guild_1", seq: 1, author_type: "user" }, null);
  assert.equal(theirs.author_name, "");
  assert.equal(theirs.preview, "");
  assert.equal(theirs.agent, null);
});

test("an operator's message is announced without looking any agent up", async () => {
  let lookups = 0;
  const notifications = hub([], {
    async getAgent() {
      lookups += 1;
      return null;
    },
  }, ["user_ada"]);
  const ada = notifications.subscribe("user_ada", "org_1");
  await notifications.observe("guild_1", "group.message.committed", {
    ...message,
    author_type: "user",
    author_name: "bo",
    author_agent_id: null,
  });
  assert.equal(lookups, 0);
  const [, data] = await ada.get();
  assert.equal(data.agent, null);
  assert.equal(data.author_name, "bo");
});

test("a message in a guild that is gone reaches nobody", async () => {
  const notifications = hub([], {}, ["user_ada"]);
  const ada = notifications.subscribe("user_ada", "org_1");
  await notifications.observe("guild_2", "group.message.committed", { ...message, guild_id: "guild_2" });
  assert.equal(ada.size, 0);
});

test("nothing is looked up while no stream is open", async () => {
  let lookups = 0;
  const notifications = hub([], {
    async getGuild() {
      lookups += 1;
      return null;
    },
  });
  await notifications.observe("guild_1", "group.message.committed", message);
  await notifications.observe("guild_1", "group.cleared", {});
  assert.equal(lookups, 0);
});

test("an issue change pings every operator of the guild", async () => {
  const notifications = hub([
    { user_id: "user_ada", name: "ada", role: "admin" },
    { user_id: "user_bo", name: "bo", role: "operator" },
  ]);
  const ada = notifications.subscribe("user_ada", "org_1");
  const bo = notifications.subscribe("user_bo", "org_1");
  const cy = notifications.subscribe("user_cy", "org_1");
  await notifications.observe("guild_1", "guild.issues.changed", { action: "create" });
  assert.equal(ada.size, 1);
  assert.equal(bo.size, 1);
  assert.equal(cy.size, 0);
  assert.deepEqual(await ada.get(), [NOTIFICATIONS_CHANGED, {}]);
  await notifications.observe("guild_1", "group.idle", {});
  assert.equal(ada.size, 0, "other guild events leave the inbox alone");
});

test("a cleared group chat pings every viewer of the guild", async () => {
  const notifications = hub([{ user_id: "user_ada", name: "ada", role: "admin" }], {}, ["user_ada", "user_bo"]);
  const ada = notifications.subscribe("user_ada", "org_1");
  const bo = notifications.subscribe("user_bo", "org_1");
  const cy = notifications.subscribe("user_cy", "org_1");
  await notifications.observe("guild_1", "group.cleared", {});
  assert.equal(ada.size, 1);
  assert.equal(bo.size, 1);
  assert.equal(cy.size, 0);
  assert.deepEqual(await bo.get(), [NOTIFICATIONS_CHANGED, {}]);
});

test("an unsubscribed stream stops receiving pings", async () => {
  const notifications = hub([]);
  const queue = notifications.subscribe("user_ada", "org_1");
  const other = notifications.subscribe("user_ada", "org_1");
  notifications.unsubscribe("user_ada", queue);
  await notifications.ping(["user_ada"]);
  assert.equal(queue.size, 0);
  assert.equal(other.size, 1, "the user's other stream still hears");
  await other.get();
  notifications.unsubscribe("user_ada", other);
  await notifications.ping(["user_ada"]);
  assert.equal(other.size, 0);
});

test("a ping reaches the user's streams in every organisation", async () => {
  const notifications = hub([]);
  const home = notifications.subscribe("user_ada", "org_1");
  const away = notifications.subscribe("user_ada", "org_2");
  await notifications.ping(["user_ada", "user_ada"]);
  assert.equal(home.size, 1);
  assert.equal(away.size, 1);
});

test("a stream that nobody drains is dropped once it holds 256 events", async () => {
  const notifications = hub([]);
  const queue = notifications.subscribe("user_ada", "org_1");
  for (let i = 0; i < 256; i += 1) {
    await notifications.ping(["user_ada"]);
  }
  assert.equal(queue.size, 256);
  await notifications.ping(["user_ada"]);
  assert.equal(queue.size, 256);
  assert.equal(notifications._subs.has("user_ada"), false);
});

test("the inbox lists how many messages are unread in each guild", async () => {
  const notifications = hub([], {
    async listUnreadGroupChats(orgId, userId) {
      assert.equal(orgId, "org_1");
      assert.equal(userId, "user_ada");
      return [
        { guild_id: "guild_1", count: "3" },
        { guild_id: "guild_2", count: 12 },
      ];
    },
  });
  assert.deepEqual(await notifications.list("org_1", "user_ada"), {
    issues: [],
    mentions: [],
    unread: [
      { guild_id: "guild_1", count: 3 },
      { guild_id: "guild_2", count: 12 },
    ],
  });
});

test("marking mentions read pings that operator", async () => {
  let orgId = "";
  let userId = "";
  const notifications = hub([], {
    async markInboxMentionsRead(org, user) {
      orgId = org;
      userId = user;
      return ["guild_1"];
    },
  });
  const ada = notifications.subscribe("user_ada", "org_1");
  const bo = notifications.subscribe("user_bo", "org_1");
  const inbox = await notifications.markMentionsRead("org_1", "user_ada");
  assert.equal(orgId, "org_1");
  assert.equal(userId, "user_ada");
  assert.deepEqual(inbox, { issues: [], mentions: [], unread: [] });
  assert.equal(ada.size, 1);
  assert.equal(bo.size, 0);
  assert.deepEqual(await ada.get(), [NOTIFICATIONS_CHANGED, {}]);
});

test("marking mentions read does not ping when no tagged chat is unread", async () => {
  const notifications = hub([]);
  const ada = notifications.subscribe("user_ada", "org_1");
  await notifications.markMentionsRead("org_1", "user_ada");
  assert.equal(ada.size, 0);
});
