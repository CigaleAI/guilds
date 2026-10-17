import assert from "node:assert/strict";
import { test } from "node:test";
import { NOTIFICATIONS_CHANGED, Notifications, type NotificationsDatabase } from "../../src/notifications/index.js";

function hub(
  operators: Array<{ user_id: string; name: string; role: string }>,
  extras: Partial<NotificationsDatabase> = {},
): Notifications {
  const db: NotificationsDatabase = {
    async getGuild(guildId) {
      return guildId === "guild_1" ? { id: guildId, operators } : null;
    },
    async listInboxIssues() {
      return [];
    },
    async listInboxMentions() {
      return [];
    },
    async markInboxMentionsRead() {
      return [];
    },
    ...extras,
  };
  return new Notifications(db);
}

test("a tagging message pings only the tagged operators", async () => {
  const notifications = hub([]);
  const ada = notifications.subscribe("user_ada");
  const bo = notifications.subscribe("user_bo");
  await notifications.observe("guild_1", "group.message.committed", { tagged_user_ids: ["user_ada"] });
  assert.equal(ada.size, 1);
  assert.equal(bo.size, 0);
  assert.deepEqual(await ada.get(), [NOTIFICATIONS_CHANGED, {}]);
});

test("an issue change pings every operator of the guild", async () => {
  const notifications = hub([
    { user_id: "user_ada", name: "ada", role: "admin" },
    { user_id: "user_bo", name: "bo", role: "operator" },
  ]);
  const ada = notifications.subscribe("user_ada");
  const bo = notifications.subscribe("user_bo");
  const cy = notifications.subscribe("user_cy");
  await notifications.observe("guild_1", "guild.issues.changed", { action: "create" });
  assert.equal(ada.size, 1);
  assert.equal(bo.size, 1);
  assert.equal(cy.size, 0);
  await notifications.observe("guild_1", "group.idle", {});
  assert.equal(ada.size, 1, "other guild events leave the inbox alone");
});

test("a cleared group chat pings every operator of the guild", async () => {
  const notifications = hub([
    { user_id: "user_ada", name: "ada", role: "admin" },
    { user_id: "user_bo", name: "bo", role: "operator" },
  ]);
  const ada = notifications.subscribe("user_ada");
  const bo = notifications.subscribe("user_bo");
  await notifications.observe("guild_1", "group.cleared", {});
  assert.equal(ada.size, 1);
  assert.equal(bo.size, 1);
});

test("an unsubscribed stream stops receiving pings", async () => {
  const notifications = hub([]);
  const queue = notifications.subscribe("user_ada");
  notifications.unsubscribe("user_ada", queue);
  await notifications.ping(["user_ada"]);
  assert.equal(queue.size, 0);
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
  const ada = notifications.subscribe("user_ada");
  const bo = notifications.subscribe("user_bo");
  const inbox = await notifications.markMentionsRead("org_1", "user_ada");
  assert.equal(orgId, "org_1");
  assert.equal(userId, "user_ada");
  assert.deepEqual(inbox, { issues: [], mentions: [] });
  assert.equal(ada.size, 1);
  assert.equal(bo.size, 0);
  assert.deepEqual(await ada.get(), [NOTIFICATIONS_CHANGED, {}]);
});

test("marking mentions read does not ping when no tagged chat is unread", async () => {
  const notifications = hub([]);
  const ada = notifications.subscribe("user_ada");
  await notifications.markMentionsRead("org_1", "user_ada");
  assert.equal(ada.size, 0);
});
