import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { connect, type Database } from "../../src/db/client.js";
import { LastOrgOwner } from "../../src/db/errors.js";
import { Repositories } from "../../src/db/repositories.js";
import { createIsolatedDatabase, dropIsolatedDatabase, uniqueDbName } from "../helpers/postgres.js";

const dbName = uniqueDbName("agent_platform_org_owners");
let database: Database;
let repo: Repositories;

before(async () => {
  database = await connect(await createIsolatedDatabase(dbName));
  repo = new Repositories(database.pool);
});

after(async () => {
  await database.close();
  await dropIsolatedDatabase(dbName);
});

async function orgWithMembers(tag: string, roles: string[]): Promise<{ orgId: string; userIds: string[] }> {
  const now = new Date();
  const userIds: string[] = [];
  for (const [index] of roles.entries()) {
    const user = await repo.insertUser(
      {
        userId: `user_${tag}_${index}`,
        name: `${tag}-${index}`,
        image: null,
        email: `${tag}-${index}@example.com`,
      },
      now,
    );
    userIds.push(String(user.id));
  }
  const orgId = `org_${tag}`;
  await repo.insertOrg({ orgId, name: tag, slug: tag, userId: userIds[0] ?? "" }, now);
  for (const [index, role] of roles.entries()) {
    if (index > 0) {
      await repo.insertMember(orgId, userIds[index] ?? "", role, now);
    }
  }
  return { orgId, userIds };
}

test("the only owner of an organisation with another member cannot be deleted, demoted, or removed", async () => {
  const { orgId, userIds } = await orgWithMembers("kept", ["owner", "member"]);
  const [owner = ""] = userIds;

  await assert.rejects(repo.deleteUser(owner), LastOrgOwner);
  await assert.rejects(repo.updateMemberRole(orgId, owner, "admin"), LastOrgOwner);
  await assert.rejects(repo.deleteMember(orgId, owner), LastOrgOwner);
  assert.equal((await repo.getMembership(orgId, owner))?.role, "owner");
});

test("an organisation left with no other member is deleted with its only owner", async () => {
  const { orgId, userIds } = await orgWithMembers("alone", ["owner"]);

  assert.ok(await repo.deleteUser(userIds[0] ?? ""));
  const remaining = await database.pool.query(`SELECT 1 FROM orgs WHERE id = $1`, [orgId]);
  assert.equal(remaining.rowCount, 0);
});

test("two owners demoted at once leave one owner", async () => {
  const { orgId, userIds } = await orgWithMembers("pair", ["owner", "owner"]);

  const results = await Promise.allSettled(userIds.map((userId) => repo.updateMemberRole(orgId, userId, "admin")));

  assert.deepEqual(results.map((result) => result.status).sort(), ["fulfilled", "rejected"]);
  const owners = await database.pool.query(`SELECT 1 FROM org_members WHERE org_id = $1 AND role = 'owner'`, [orgId]);
  assert.equal(owners.rowCount, 1);
});

test("an owner and a co-owner removed at once leave one owner", async () => {
  const { orgId, userIds } = await orgWithMembers("split", ["owner", "owner", "member"]);
  const [first = "", second = ""] = userIds;

  const results = await Promise.allSettled([repo.deleteUser(first), repo.deleteMember(orgId, second)]);

  assert.deepEqual(results.map((result) => result.status).sort(), ["fulfilled", "rejected"]);
  const owners = await database.pool.query(`SELECT 1 FROM org_members WHERE org_id = $1 AND role = 'owner'`, [orgId]);
  assert.equal(owners.rowCount, 1);
});
