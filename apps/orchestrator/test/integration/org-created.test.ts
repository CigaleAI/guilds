import assert from "node:assert/strict";
import { after, test } from "node:test";
import { connect } from "../../src/db/client.js";
import { insertOrg, listOrgsForUser, type OrgCreatedHook } from "../../src/db/orgs.js";
import { getUser, insertUser } from "../../src/db/users.js";
import { newId } from "../../src/lib/ids.js";
import { HEX_MASTER_KEY } from "../helpers/env.js";
import { createIsolatedDatabase, dropIsolatedDatabase, uniqueDbName } from "../helpers/postgres.js";

const dbName = uniqueDbName("agent_platform_org_created");

after(async () => {
  await dropIsolatedDatabase(dbName);
});

test("a new organisation is handed to the extension's hook inside its transaction", { timeout: 60_000 }, async () => {
  process.env.SECRETS_MASTER_KEY = HEX_MASTER_KEY;
  const database = await connect(await createIsolatedDatabase(dbName));
  const count = async (table: string, orgId: string) =>
    Number((await database.pool.query(`SELECT COUNT(*)::int AS n FROM ${table} WHERE org_id = $1`, [orgId])).rows[0].n);
  const orgExists = async (orgId: string) =>
    Boolean((await database.pool.query("SELECT 1 FROM orgs WHERE id = $1", [orgId])).rowCount);

  try {
    // Core alone: the organisation and its owner.
    const db = database.pool;
    const plain = await insertOrg(
      db,
      { orgId: newId("org"), name: "plain", slug: "plain", userId: "user_operator" },
      new Date(),
    );
    assert.equal(await count("org_members", String(plain.id)), 1);

    // The hook sees the organisation it was called for, before anyone else can.
    const seen: Array<{ id: string; visibleInside: boolean; visibleOutside: boolean }> = [];
    const hook: OrgCreatedHook = async (client, org) => {
      seen.push({
        id: org.id,
        visibleInside: Boolean((await client.query("SELECT 1 FROM orgs WHERE id = $1", [org.id])).rowCount),
        visibleOutside: await orgExists(org.id),
      });
    };
    const made = await insertOrg(
      db,
      { orgId: newId("org"), name: "hooked", slug: "hooked", userId: "user_operator" },
      new Date(),
      hook,
    );
    assert.deepEqual(seen, [{ id: String(made.id), visibleInside: true, visibleOutside: false }]);

    // A user's personal organisation goes through the hook too.
    const user = await insertUser(
      db,
      { userId: newId("user"), name: "newcomer", image: null, email: "newcomer@example.com" },
      new Date(),
      hook,
    );
    const personal = (await listOrgsForUser(db, String(user.id)))[0];
    assert.equal(seen.at(-1)?.id, String(personal?.id));

    // A hook that fails takes the organisation with it.
    const failing: OrgCreatedHook = async () => {
      throw new Error("no plan to start on");
    };
    const orgId = newId("org");
    await assert.rejects(
      () =>
        insertOrg(
          db,
          { orgId, name: "doomed", slug: "doomed", userId: "user_operator" },
          new Date(),
          failing,
        ),
      /no plan to start on/,
    );
    assert.equal(await orgExists(orgId), false);
    const userId = newId("user");
    await assert.rejects(
      () => insertUser(db, { userId, name: "doomed-user" }, new Date(), failing),
      /no plan to start on/,
    );
    assert.equal(await getUser(db, userId), null);
  } finally {
    await database.close();
  }
});
