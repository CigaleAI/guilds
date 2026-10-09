import assert from "node:assert/strict";
import { after, test } from "node:test";
import { connect } from "../../src/db/client.js";
import { Repositories, type OrgCreatedHook } from "../../src/db/repositories.js";
import { newId } from "../../src/lib/ids.js";
import { HEX_MASTER_KEY } from "../helpers/env.js";
import { createIsolatedDatabase, dropIsolatedDatabase, uniqueDbName } from "../helpers/postgres.js";

const dbName = uniqueDbName("agent_platform_org_created");

after(async () => {
  await dropIsolatedDatabase(dbName);
});

test("a new organisation is handed to the edition's hook inside its transaction", { timeout: 60_000 }, async () => {
  process.env.SECRETS_MASTER_KEY = HEX_MASTER_KEY;
  const database = await connect(await createIsolatedDatabase(dbName));
  const count = async (table: string, orgId: string) =>
    Number((await database.pool.query(`SELECT COUNT(*)::int AS n FROM ${table} WHERE org_id = $1`, [orgId])).rows[0].n);
  const orgExists = async (orgId: string) =>
    Boolean((await database.pool.query("SELECT 1 FROM orgs WHERE id = $1", [orgId])).rowCount);

  try {
    // Core alone: the organisation and its owner.
    const core = new Repositories(database.pool);
    const plain = await core.insertOrg(newId("org"), "plain", "plain", "user_operator", new Date());
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
    const hooked = new Repositories(database.pool, { orgCreated: hook });
    const made = await hooked.insertOrg(newId("org"), "hooked", "hooked", "user_operator", new Date());
    assert.deepEqual(seen, [{ id: String(made.id), visibleInside: true, visibleOutside: false }]);

    // A user's personal organisation goes through the hook too.
    const user = await hooked.insertUser(newId("user"), "newcomer", new Date(), null, "newcomer@example.com");
    const personal = (await hooked.listOrgsForUser(String(user.id)))[0];
    assert.equal(seen.at(-1)?.id, String(personal?.id));

    // A hook given for one creation runs in place of the repositories' own.
    const before = seen.length;
    const once: string[] = [];
    await hooked.insertUser(newId("user"), "registrant", new Date(), null, "registrant@example.com", {
      orgCreated: async (_client, org) => {
        once.push(org.id);
      },
    });
    assert.equal(once.length, 1);
    assert.equal(seen.length, before);

    // A hook that fails takes the organisation with it.
    const failing = new Repositories(database.pool, {
      orgCreated: async () => {
        throw new Error("no plan to start on");
      },
    });
    const orgId = newId("org");
    await assert.rejects(() => failing.insertOrg(orgId, "doomed", "doomed", "user_operator", new Date()), /no plan to start on/);
    assert.equal(await orgExists(orgId), false);
    const userId = newId("user");
    await assert.rejects(() => failing.insertUser(userId, "doomed-user", new Date()), /no plan to start on/);
    assert.equal(await failing.getUser(userId), null);
  } finally {
    await database.close();
  }
});
