import assert from "node:assert/strict";
import { test } from "node:test";
import {
  NOTICE_PREVIEW_LENGTH,
  NOTIFICATIONS_CHANGED,
  NOTIFICATIONS_ISSUE,
  NOTIFICATIONS_MESSAGE,
  Notifications,
  messageNotice,
  withEveryDisablingIssue,
  type NotificationsDatabase,
} from "../../src/notifications/index.js";
import type { GroupChatView } from "../../src/groupchat/index.js";
import type { GroupMessageView } from "../../src/db/views.js";
import { overflowStream, sseApp } from "../helpers/sse.js";

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
      return guildId === "guild_1" ? { id: guildId, org_id: "org_1", name: "alpha", operators } : null;
    },
    async getIssue() {
      return null;
    },
    async listGuildViewerIds(guildId) {
      return guildId === "guild_1" ? viewers : [];
    },
    async listInboxIssues() {
      return [];
    },
    async listDisablingIssues() {
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

const message: GroupMessageView = {
  id: 70,
  seq: 7,
  author_type: "agent",
  author_name: "scout",
  author_agent_id: "agent_scout",
  author_user_id: null,
  source_run_id: "run_1",
  content: "the feed is back",
  tagged: ["ada"],
  tagged_agent_ids: [],
  tagged_user_ids: ["user_ada"],
  created_at: "2026-01-01T00:00:00.000Z",
};

/** The guild's chat as a cleared or idle event carries it. */
const chat: GroupChatView = {
  guild_id: "guild_1",
  chat_seq: 7,
  agent_message_count: 0,
  agent_message_limit: 10,
  dispatching: false,
  pending_agent_count: 0,
  active_agents: [],
  limit_reached: false,
  errors: [],
  last_recipient_decision: null,
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
  assert.deepEqual(messageNotice("guild_1", message, scout), notice);
  const long = messageNotice("guild_1", { ...message, content: "x".repeat(NOTICE_PREVIEW_LENGTH + 50) }, scout);
  assert.equal(long.preview.length, NOTICE_PREVIEW_LENGTH);
  const bare = messageNotice("guild_1", message, { id: "agent_scout", name: "", avatar_shape: null, avatar_color: null });
  assert.deepEqual(bare.agent, { id: "agent_scout", name: "", avatar_shape: "teardrop", avatar_color: "#7c5cff" });
});

test("an operator's message has no agent, and an empty one no preview", () => {
  const theirs = messageNotice(
    "guild_1",
    { ...message, seq: 1, author_type: "user", author_name: "", author_agent_id: null, content: "" },
    null,
  );
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
  const [name, data] = await ada.get();
  assert.equal(name, NOTIFICATIONS_MESSAGE);
  assert.equal(data.agent, null);
  assert.equal("author_name" in data && data.author_name, "bo");
});

test("a message in a guild that is gone reaches nobody", async () => {
  const notifications = hub([], {}, ["user_ada"]);
  const ada = notifications.subscribe("user_ada", "org_1");
  await notifications.observe("guild_2", "group.message.committed", message);
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
  await notifications.observe("guild_1", "group.cleared", chat);
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
  await notifications.observe("guild_1", "group.idle", chat);
  assert.equal(ada.size, 0, "other guild events leave the inbox alone");
});

test("a reported issue is announced to the guild's operators in its organisation, then pings them", async () => {
  const reported = {
    id: "iss_1",
    guild_id: "guild_1",
    org_id: "org_1",
    agent_id: "agent_scout",
    agent_name: "scout",
    run_id: "r_1",
    kind: "api",
    severity: "blocking",
    status: "open",
    summary: "Gmail login revoked",
    detail: "401 on every call",
    tool_name: null,
    created_at: "2026-10-12T09:00:00.000Z",
    updated_at: "2026-10-12T09:00:00.000Z",
    resolved_at: null,
    resolved_by: null,
    live_agent_name: "scout",
    avatar_shape: "clay:scout",
    avatar_color: "#1d9bf0",
  };
  const notifications = hub([{ user_id: "user_ada", name: "ada", role: "admin" }], {
    async getIssue(guildId, issueId) {
      return guildId === "guild_1" && issueId === "iss_1" ? reported : null;
    },
  });
  const ada = notifications.subscribe("user_ada", "org_1");
  const adaElsewhere = notifications.subscribe("user_ada", "org_2");
  const cy = notifications.subscribe("user_cy", "org_1");

  await notifications.observe("guild_1", "guild.issues.changed", { action: "create", issue_id: "iss_1" });

  const [name, data] = await ada.get();
  assert.equal(name, NOTIFICATIONS_ISSUE);
  assert.deepEqual(
    { id: "id" in data && data.id, severity: "severity" in data && data.severity, guild: "guild_name" in data && data.guild_name },
    { id: "iss_1", severity: "blocking", guild: "alpha" },
  );
  assert.deepEqual(await ada.get(), [NOTIFICATIONS_CHANGED, {}]);
  assert.deepEqual(await adaElsewhere.get(), [NOTIFICATIONS_CHANGED, {}], "another organisation's stream is only pinged");
  assert.equal(cy.size, 0, "someone who does not operate the guild hears nothing");
});

test("a reported issue that is gone only pings the operators", async () => {
  const notifications = hub([{ user_id: "user_ada", name: "ada", role: "admin" }]);
  const ada = notifications.subscribe("user_ada", "org_1");
  await notifications.observe("guild_1", "guild.issues.changed", { action: "create", issue_id: "iss_gone" });
  assert.equal(ada.size, 1);
  assert.deepEqual(await ada.get(), [NOTIFICATIONS_CHANGED, {}]);
});

test("a resolved issue pings the operators without announcing it", async () => {
  const notifications = hub([{ user_id: "user_ada", name: "ada", role: "admin" }]);
  const ada = notifications.subscribe("user_ada", "org_1");
  await notifications.observe("guild_1", "guild.issues.changed", { action: "resolved", issue_id: "iss_1" });
  assert.equal(ada.size, 1);
  assert.deepEqual(await ada.get(), [NOTIFICATIONS_CHANGED, {}]);
});

test("a cleared group chat pings every viewer of the guild", async () => {
  const notifications = hub([{ user_id: "user_ada", name: "ada", role: "admin" }], {}, ["user_ada", "user_bo"]);
  const ada = notifications.subscribe("user_ada", "org_1");
  const bo = notifications.subscribe("user_bo", "org_1");
  const cy = notifications.subscribe("user_cy", "org_1");
  await notifications.observe("guild_1", "group.cleared", chat);
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
  assert.equal(queue.dropped, true);
  assert.equal(queue.size, 0);
  assert.equal(notifications._subs.has("user_ada"), false);
});

test("a_slow_inbox_subscriber_is_closed_not_silenced", async () => {
  const notifications = hub([]);
  const { app, opened } = sseApp(
    () => notifications.subscribe("user_ada", "org_1"),
    (queue) => notifications.unsubscribe("user_ada", queue),
  );
  const { body, queue } = await overflowStream(app, opened, () =>
    Array.from({ length: 512 }, () => notifications.ping(["user_ada"])),
  );
  assert.equal(queue.dropped, true);
  assert.ok(body.startsWith(": connected\n\n"), body.slice(0, 40));
  assert.equal(notifications._subs.has("user_ada"), false);
  await app.close();
});

test("the inbox lists how many messages are unread in each guild", async () => {
  const notifications = hub([], {
    async listUnreadGroupChats(orgId, userId) {
      assert.equal(orgId, "org_1");
      assert.equal(userId, "user_ada");
      return [
        { guild_id: "guild_1", count: 3 },
        { guild_id: "guild_2", count: 12 },
      ];
    },
  });
  assert.deepEqual(await notifications.list("org_1", "user_ada"), {
    issues: [],
    disabling: [],
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
  assert.deepEqual(inbox, { issues: [], disabling: [], mentions: [], unread: [] });
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

test("the inbox's page of issues gains each disabling issue it left out, newest first", () => {
  const row = (id: string, at: string) => ({ id, created_at: at }) as Parameters<typeof withEveryDisablingIssue>[0][number];
  const page = [row("c", "2026-01-03T00:00:00.000Z"), row("b", "2026-01-02T00:00:00.000Z")];
  const old = row("a", "2026-01-01T00:00:00.000Z");
  assert.deepEqual(
    withEveryDisablingIssue(page, [old, page[1]!]).map((issue) => issue.id),
    ["c", "b", "a"],
  );
  assert.equal(withEveryDisablingIssue(page, [page[0]!]), page, "a page that holds them all is returned as it is");
});
