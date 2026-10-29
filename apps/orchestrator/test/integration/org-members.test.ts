import assert from "node:assert/strict";
import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { after, test } from "node:test";
import { buildApp } from "../../src/app.js";
import { connect } from "../../src/seed/connect.js";
import { NotesStore } from "../../src/notes/store.js";
import { agentScripts } from "../../src/scripts/catalog.js";
import { scheduleDatabase, Schedules } from "../../src/schedules/service.js";
import { HEX_MASTER_KEY, tempDir } from "../helpers/env.js";
import { templatesRoot } from "../helpers/fixtures.js";
import { createIsolatedDatabase, dropIsolatedDatabase, r1DatabaseUrl, uniqueDbName } from "../helpers/postgres.js";

const OWNER = {
  "X-Guilds-User": "user_operator",
  "X-Guilds-Org": "org_home",
};

const dbName = uniqueDbName("agent_platform_org_members");

after(async () => {
  await dropIsolatedDatabase(dbName);
});

test(
  "a new user joins the organisation by name and becomes a second guild admin",
  { timeout: 60_000 },
  async () => {
    process.env.SECRETS_MASTER_KEY = HEX_MASTER_KEY;
    const databaseUrl = await createIsolatedDatabase(dbName);
    const database = await connect(databaseUrl);
    const notes = new NotesStore(tempDir("guilds-org-members-"), templatesRoot());
    await notes.ensureSystemPrompt();
    const db = database.pool;
    const app = await buildApp(database, {
      db,
      notes,
      scripts: agentScripts(db),
      schedules: new Schedules(scheduleDatabase(db)),
    });
    const json = { ...OWNER, "content-type": "application/json" };

    try {
      const created = await app.inject({
        method: "POST",
        url: "/api/users",
        headers: { "content-type": "application/json" },
        payload: { name: "second-admin" },
      });
      assert.equal(created.statusCode, 201, created.body);
      const userId = String(created.json().id);

      const unknown = await app.inject({
        method: "POST",
        url: "/api/orgs/org_home/members",
        headers: json,
        payload: { name: "nobody-here" },
      });
      assert.equal(unknown.statusCode, 404);
      const neither = await app.inject({
        method: "POST",
        url: "/api/orgs/org_home/members",
        headers: json,
        payload: { role: "member" },
      });
      assert.equal(neither.statusCode, 422);

      const added = await app.inject({
        method: "POST",
        url: "/api/orgs/org_home/members",
        headers: json,
        payload: { name: " @Second-Admin ", role: "member" },
      });
      assert.equal(added.statusCode, 201, added.body);
      assert.equal(added.json().user_id, userId);
      assert.equal(added.json().role, "member");
      const again = await app.inject({
        method: "POST",
        url: "/api/orgs/org_home/members",
        headers: json,
        payload: { name: "second-admin" },
      });
      assert.equal(again.statusCode, 409);

      const NEWCOMER = {
        "X-Guilds-User": userId,
        "X-Guilds-Org": "org_home",
        "content-type": "application/json",
      };
      const memberAdds = await app.inject({
        method: "POST",
        url: "/api/orgs/org_home/members",
        headers: NEWCOMER,
        payload: { name: "operator" },
      });
      assert.equal(memberAdds.statusCode, 404, "a plain member cannot add people");

      const guild = await app.inject({
        method: "POST",
        url: "/api/guilds",
        headers: json,
        payload: { name: "two-admins", visibility: "private" },
      });
      assert.equal(guild.statusCode, 201, guild.body);
      const promoted = await app.inject({
        method: "PUT",
        url: `/api/guilds/${String(guild.json().id)}/operators/${userId}`,
        headers: json,
        payload: { role: "admin" },
      });
      assert.equal(promoted.statusCode, 200, promoted.body);
      assert.deepEqual(
        promoted
          .json()
          .operators.map((row: { name: string; role: string }) => [row.name, row.role]),
        [
          ["operator", "admin"],
          ["second-admin", "admin"],
        ],
      );
    } finally {
      await app.close();
      await database.close();
    }
  },
);

test(
  "members change roles, leave, and are removed without stranding an organisation or a guild",
  { timeout: 60_000 },
  async () => {
    process.env.SECRETS_MASTER_KEY = HEX_MASTER_KEY;
    const database = await connect(r1DatabaseUrl(dbName));
    const notes = new NotesStore(tempDir("guilds-org-roles-"), templatesRoot());
    await notes.ensureSystemPrompt();
    const db = database.pool;
    const app = await buildApp(database, {
      db,
      notes,
      scripts: agentScripts(db),
      schedules: new Schedules(scheduleDatabase(db)),
    });
    const as = (userId: string) => ({ "X-Guilds-User": userId, "X-Guilds-Org": "org_home" });
    const call = (method: "POST" | "PATCH" | "DELETE" | "PUT", url: string, headers: Record<string, string>, payload?: object) =>
      app.inject({ method, url, headers: payload ? { ...headers, "content-type": "application/json" } : headers, ...(payload ? { payload } : {}) });

    try {
      const created = await call("POST", "/api/users", {}, { name: "deputy" });
      assert.equal(created.statusCode, 201, created.body);
      const deputy = String(created.json().id);
      const owner = as("user_operator");
      assert.equal((await call("POST", "/api/orgs/org_home/members", owner, { user_id: deputy, role: "admin" })).statusCode, 201);

      const promotes = await call("PATCH", "/api/orgs/org_home/members/user_operator", as(deputy), { role: "member" });
      assert.equal(promotes.statusCode, 404, "an admin cannot change an owner");
      const crowns = await call("PATCH", `/api/orgs/org_home/members/${deputy}`, as(deputy), { role: "owner" });
      assert.equal(crowns.statusCode, 404, "an admin cannot grant ownership");
      const demoted = await call("PATCH", "/api/orgs/org_home/members/user_operator", owner, { role: "admin" });
      assert.equal(demoted.statusCode, 409, "the last owner stays an owner");
      const missing = await call("PATCH", "/api/orgs/org_home/members/user_nobody", owner, { role: "member" });
      assert.equal(missing.statusCode, 404);
      const invalid = await call("PATCH", `/api/orgs/org_home/members/${deputy}`, owner, { role: "boss" });
      assert.equal(invalid.statusCode, 422);

      const guild = await call("POST", "/api/guilds", as(deputy), { name: "deputy-desk", visibility: "private" });
      assert.equal(guild.statusCode, 201, guild.body);
      const leaves = await call("DELETE", `/api/orgs/org_home/members/${deputy}`, as(deputy));
      assert.equal(leaves.statusCode, 409, "the only admin of a guild stays until another is named");
      assert.match(String(leaves.json().detail), /only admin of deputy-desk/);
      const deletes = await call("DELETE", `/api/users/${deputy}`, {});
      assert.equal(deletes.statusCode, 409);
      await call("PUT", `/api/guilds/${String(guild.json().id)}/operators/user_operator`, as(deputy), { role: "admin" });
      assert.equal((await call("DELETE", `/api/orgs/org_home/members/${deputy}`, as(deputy))).statusCode, 204);
      assert.equal((await call("DELETE", `/api/orgs/org_home/members/${deputy}`, owner)).statusCode, 404);
      assert.equal((await call("DELETE", "/api/orgs/org_home/members/user_operator", owner)).statusCode, 409);

      assert.equal((await call("DELETE", `/api/users/${deputy}`, {})).statusCode, 204);
      assert.equal((await call("DELETE", `/api/users/${deputy}`, {})).statusCode, 404);
      assert.equal((await call("DELETE", "/api/users/user_operator", {})).statusCode, 400);
    } finally {
      await app.close();
      await database.close();
    }
  },
);

test("an organisation's slug is unique, and a new slug moves its notes folder", { timeout: 60_000 }, async () => {
  process.env.SECRETS_MASTER_KEY = HEX_MASTER_KEY;
  const database = await connect(r1DatabaseUrl(dbName));
  const notes = new NotesStore(tempDir("guilds-org-slug-"), templatesRoot());
  await notes.ensureSystemPrompt();
  const db = database.pool;
  const app = await buildApp(database, {
    db,
    notes,
    scripts: agentScripts(db),
    schedules: new Schedules(scheduleDatabase(db)),
  });
  const json = { ...OWNER, "content-type": "application/json" };

  try {
    const lab = await app.inject({ method: "POST", url: "/api/orgs", headers: json, payload: { name: "Lab", slug: "lab" } });
    assert.equal(lab.statusCode, 201, lab.body);
    assert.equal(lab.json().role, "owner");
    const taken = await app.inject({ method: "POST", url: "/api/orgs", headers: json, payload: { name: "Lab 2", slug: "lab" } });
    assert.equal(taken.statusCode, 409);
    const clash = await app.inject({ method: "PATCH", url: "/api/orgs/org_home", headers: json, payload: { slug: "lab" } });
    assert.equal(clash.statusCode, 409);

    mkdirSync(path.join(notes.root, "orgs", "lab", "guilds"), { recursive: true });
    const moved = await app.inject({
      method: "PATCH",
      url: `/api/orgs/${String(lab.json().id)}`,
      headers: json,
      payload: { name: "Laboratory", slug: "laboratory" },
    });
    assert.equal(moved.statusCode, 200, moved.body);
    assert.deepEqual([moved.json().name, moved.json().slug, moved.json().role], ["Laboratory", "laboratory", "owner"]);
    assert.ok(existsSync(path.join(notes.root, "orgs", "laboratory", "guilds")));
    assert.ok(!existsSync(path.join(notes.root, "orgs", "lab")));
  } finally {
    await app.close();
    await database.close();
  }
});
