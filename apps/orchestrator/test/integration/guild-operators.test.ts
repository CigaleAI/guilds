import assert from "node:assert/strict";
import { after, test } from "node:test";
import { buildApp } from "../../src/app.js";
import { connect } from "../../src/db/client.js";
import { Repositories } from "../../src/db/repositories.js";
import { TEST_MODEL, connectModelProvider } from "../helpers/models.js";
import { NotesStore } from "../../src/notes/store.js";
import { Scripts } from "../../src/scripts/catalog.js";
import { Schedules } from "../../src/schedules/service.js";
import { HEX_MASTER_KEY, tempDir } from "../helpers/env.js";
import { templatesRoot } from "../helpers/fixtures.js";
import {
  createIsolatedDatabase,
  dropIsolatedDatabase,
  uniqueDbName,
} from "../helpers/postgres.js";

const OWNER = {
  "X-Guilds-User": "user_operator",
  "X-Guilds-Org": "org_home",
};

const dbName = uniqueDbName("agent_platform_guild_operators");

after(async () => {
  await dropIsolatedDatabase(dbName);
});

test("guild admins manage operators, and private guilds show only to operators", { timeout: 60_000 }, async () => {
  process.env.SECRETS_MASTER_KEY = HEX_MASTER_KEY;
  const databaseUrl = await createIsolatedDatabase(dbName);
  const database = await connect(databaseUrl);
  const notes = new NotesStore(tempDir("guilds-operators-notes-"), templatesRoot());
  await notes.ensureSystemPrompt();
  const repo = new Repositories(database.pool);
  await connectModelProvider(repo, "org_home", "deepinfra");
  const app = await buildApp(database, {
    repo,
    notes,
    scripts: new Scripts(repo),
    schedules: new Schedules(repo),
  });

  const teammate = await repo.insertUser("user_teammate_ops", "teammate-ops", new Date(), null, "teammate-ops@example.com");
  await repo.insertMember("org_home", String(teammate.id), "member", new Date());
  const outsider = await repo.insertUser("user_outsider_ops", "outsider-ops", new Date(), null, "outsider-ops@elsewhere.dev");
  const TEAMMATE = {
    "X-Guilds-User": String(teammate.id),
    "X-Guilds-Org": "org_home",
  };
  const json = { "content-type": "application/json" };

  try {
    const shared = await app.inject({
      method: "POST",
      url: "/api/guilds",
      headers: { ...OWNER, ...json },
      payload: { name: "shared-desk", visibility: "org" },
    });
    assert.equal(shared.statusCode, 201);
    const sharedId = String(shared.json().id);

    const hidden = await app.inject({
      method: "POST",
      url: "/api/guilds",
      headers: { ...OWNER, ...json },
      payload: { name: "personal-lab", visibility: "private" },
    });
    assert.equal(hidden.statusCode, 201);
    assert.equal(hidden.json().visibility, "private");
    assert.deepEqual(hidden.json().operators, [{ user_id: "user_operator", name: "operator", role: "admin" }]);
    const privateId = String(hidden.json().id);

    const teammateNames = (await app.inject({ method: "GET", url: "/api/guilds", headers: TEAMMATE }))
      .json()
      .map((row: { name: string }) => row.name);
    assert.ok(teammateNames.includes("shared-desk"));
    assert.equal(teammateNames.includes("personal-lab"), false);
    const denied = await app.inject({ method: "GET", url: `/api/guilds/${privateId}`, headers: TEAMMATE });
    assert.equal(denied.statusCode, 404);

    const usage = await app.inject({ method: "GET", url: "/api/usage", headers: TEAMMATE });
    const home = usage.json().organisation as { id: string; guilds: Array<{ name: string }> };
    assert.equal(home.id, "org_home");
    const usageNames = home.guilds.map((row) => row.name);
    assert.ok(usageNames.includes("shared-desk"));
    assert.equal(usageNames.includes("personal-lab"), false);

    const steal = await app.inject({
      method: "PUT",
      url: `/api/guilds/${privateId}`,
      headers: { ...TEAMMATE, ...json },
      payload: { visibility: "org" },
    });
    assert.equal(steal.statusCode, 404);
    const memberPrivatize = await app.inject({
      method: "PUT",
      url: `/api/guilds/${sharedId}`,
      headers: { ...TEAMMATE, ...json },
      payload: { visibility: "private" },
    });
    assert.equal(memberPrivatize.statusCode, 403);
    const memberAbout = await app.inject({
      method: "PUT",
      url: `/api/guilds/${sharedId}`,
      headers: { ...TEAMMATE, ...json },
      payload: { about: "anyone who sees an org guild can still edit it" },
    });
    assert.equal(memberAbout.statusCode, 200);

    const notMember = await app.inject({
      method: "PUT",
      url: `/api/guilds/${privateId}/operators/${String(outsider.id)}`,
      headers: { ...OWNER, ...json },
      payload: { role: "operator" },
    });
    assert.equal(notMember.statusCode, 422);
    const badRole = await app.inject({
      method: "PUT",
      url: `/api/guilds/${privateId}/operators/${String(teammate.id)}`,
      headers: { ...OWNER, ...json },
      payload: { role: "owner" },
    });
    assert.equal(badRole.statusCode, 422);

    const invited = await app.inject({
      method: "PUT",
      url: `/api/guilds/${privateId}/operators/${String(teammate.id)}`,
      headers: { ...OWNER, ...json },
      payload: { role: "operator" },
    });
    assert.equal(invited.statusCode, 200, invited.body);
    assert.deepEqual(
      invited.json().operators.map((row: { name: string; role: string }) => [row.name, row.role]),
      [
        ["operator", "admin"],
        ["teammate-ops", "operator"],
      ],
    );
    const seen = await app.inject({ method: "GET", url: `/api/guilds/${privateId}`, headers: TEAMMATE });
    assert.equal(seen.statusCode, 200);

    const operatorInvites = await app.inject({
      method: "PUT",
      url: `/api/guilds/${privateId}/operators/user_operator`,
      headers: { ...TEAMMATE, ...json },
      payload: { role: "operator" },
    });
    assert.equal(operatorInvites.statusCode, 403);
    const operatorDeletes = await app.inject({ method: "DELETE", url: `/api/guilds/${privateId}`, headers: TEAMMATE });
    assert.equal(operatorDeletes.statusCode, 403);

    const lastAdmin = await app.inject({
      method: "PUT",
      url: `/api/guilds/${privateId}/operators/user_operator`,
      headers: { ...OWNER, ...json },
      payload: { role: "operator" },
    });
    assert.equal(lastAdmin.statusCode, 409);
    const lastAdminLeaves = await app.inject({
      method: "DELETE",
      url: `/api/guilds/${privateId}/operators/user_operator`,
      headers: OWNER,
    });
    assert.equal(lastAdminLeaves.statusCode, 409);
    const soleAdminRemoved = await app.inject({
      method: "DELETE",
      url: `/api/orgs/org_home/members/user_operator`,
      headers: OWNER,
    });
    assert.equal(soleAdminRemoved.statusCode, 409);

    // An agent may not take an operator's name, and the reverse.
    const clash = await app.inject({
      method: "POST",
      url: `/api/guilds/${privateId}/agents`,
      headers: { ...OWNER, ...json },
      payload: { name: "teammate-ops", config: { model: TEST_MODEL, browser: false } },
    });
    assert.equal(clash.statusCode, 409, clash.body);
    const agent = await app.inject({
      method: "POST",
      url: `/api/guilds/${sharedId}/agents`,
      headers: { ...OWNER, ...json },
      payload: { name: "outsider-ops", config: { model: TEST_MODEL, browser: false } },
    });
    assert.equal(agent.statusCode, 201, agent.body);
    const renamed = await app.inject({
      method: "PATCH",
      url: "/api/auth/me",
      headers: { ...OWNER, ...json },
      payload: { name: "outsider-ops" },
    });
    assert.equal(renamed.statusCode, 409, renamed.body);
    assert.equal(renamed.json().detail, "outsider-ops is already an agent in a guild you operate");
    await repo.insertMember("org_home", String(outsider.id), "member", new Date());
    const operatorClash = await app.inject({
      method: "PUT",
      url: `/api/guilds/${sharedId}/operators/${String(outsider.id)}`,
      headers: { ...OWNER, ...json },
      payload: { role: "operator" },
    });
    assert.equal(operatorClash.statusCode, 409);

    const promoted = await app.inject({
      method: "PUT",
      url: `/api/guilds/${privateId}/operators/${String(teammate.id)}`,
      headers: { ...OWNER, ...json },
      payload: { role: "admin" },
    });
    assert.equal(promoted.statusCode, 200);
    const stepDown = await app.inject({
      method: "DELETE",
      url: `/api/guilds/${privateId}/operators/user_operator`,
      headers: OWNER,
    });
    assert.equal(stepDown.statusCode, 200);
    const gone = await app.inject({ method: "GET", url: `/api/guilds/${privateId}`, headers: OWNER });
    assert.equal(gone.statusCode, 404);

    const adminShares = await app.inject({
      method: "PUT",
      url: `/api/guilds/${privateId}`,
      headers: { ...TEAMMATE, ...json },
      payload: { visibility: "org" },
    });
    assert.equal(adminShares.statusCode, 200);
    assert.equal(adminShares.json().visibility, "org");
    const ownerAfterShare = await app.inject({ method: "GET", url: `/api/guilds/${privateId}`, headers: OWNER });
    assert.equal(ownerAfterShare.statusCode, 200);

    const adminDeletes = await app.inject({ method: "DELETE", url: `/api/guilds/${sharedId}`, headers: TEAMMATE });
    assert.equal(adminDeletes.statusCode, 403);
  } finally {
    await app.close();
    await database.close();
  }
});
