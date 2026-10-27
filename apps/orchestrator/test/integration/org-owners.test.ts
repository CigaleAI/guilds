import type pg from "pg";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { connect, type Database } from "../../src/db/client.js";
import { LastOrgOwner } from "../../src/db/errors.js";
import { createIsolatedDatabase, dropIsolatedDatabase, uniqueDbName } from "../helpers/postgres.js";
import { deleteUser, insertUser } from "../../src/db/users.js";
import {
  deleteMember,
  getMembership,
  insertMember,
  insertOrg,
  updateMemberRole,
} from "../../src/db/orgs.js";

const dbName = uniqueDbName("agent_platform_org_owners");
let database: Database;
let db: pg.Pool;

before(async () => {
  database = await connect(await createIsolatedDatabase(dbName));
  db = database.pool;
});

after(async () => {
  await database.close();
  await dropIsolatedDatabase(dbName);
});

async function orgWithMembers(tag: string, roles: string[]): Promise<{ orgId: string; userIds: string[] }> {
  const now = new Date();
  const userIds: string[] = [];
  for (const [index] of roles.entries()) {
    const user = await insertUser(db, {
        userId: `user_${tag}_${index}`,
        name: `${tag}-${index}`,
        image: null,
        email: `${tag}-${index}@example.com`,
      }, now);
    userIds.push(String(user.id));
  }
  const orgId = `org_${tag}`;
  await insertOrg(db, { orgId, name: tag, slug: tag, userId: userIds[0] ?? "" }, now);
  for (const [index, role] of roles.entries()) {
    if (index > 0) {
      await insertMember(db, orgId, userIds[index] ?? "", role, now);
    }
  }
  return { orgId, userIds };
}

test("the only owner of an organisation with another member cannot be deleted, demoted, or removed", async () => {
  const { orgId, userIds } = await orgWithMembers("kept", ["owner", "member"]);
  const [owner = ""] = userIds;

  await assert.rejects(deleteUser(db, owner), LastOrgOwner);
  await assert.rejects(updateMemberRole(db, orgId, owner, "admin"), LastOrgOwner);
  await assert.rejects(deleteMember(db, orgId, owner), LastOrgOwner);
  assert.equal((await getMembership(db, orgId, owner))?.role, "owner");
});

test("an organisation left with no other member is deleted with its only owner", async () => {
  const { orgId, userIds } = await orgWithMembers("alone", ["owner"]);

  assert.ok(await deleteUser(db, userIds[0] ?? ""));
  const remaining = await database.pool.query(`SELECT 1 FROM orgs WHERE id = $1`, [orgId]);
  assert.equal(remaining.rowCount, 0);
});

test("two owners demoted at once leave one owner", async () => {
  const { orgId, userIds } = await orgWithMembers("pair", ["owner", "owner"]);

  const results = await Promise.allSettled(userIds.map((userId) => updateMemberRole(db, orgId, userId, "admin")));

  assert.deepEqual(results.map((result) => result.status).sort(), ["fulfilled", "rejected"]);
  const owners = await database.pool.query(`SELECT 1 FROM org_members WHERE org_id = $1 AND role = 'owner'`, [orgId]);
  assert.equal(owners.rowCount, 1);
});

test("an owner and a co-owner removed at once leave one owner", async () => {
  const { orgId, userIds } = await orgWithMembers("split", ["owner", "owner", "member"]);
  const [first = "", second = ""] = userIds;

  const results = await Promise.allSettled([deleteUser(db, first), deleteMember(db, orgId, second)]);

  assert.deepEqual(results.map((result) => result.status).sort(), ["fulfilled", "rejected"]);
  const owners = await database.pool.query(`SELECT 1 FROM org_members WHERE org_id = $1 AND role = 'owner'`, [orgId]);
  assert.equal(owners.rowCount, 1);
});
