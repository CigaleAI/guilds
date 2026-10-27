import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { resetBinding, writeBinding } from "../../src/access/bindings.js";
import type { Database } from "../../src/db/client.js";
import { userActor } from "../../src/lib/change-actor.js";
import { connect } from "../../src/seed/connect.js";
import { createIsolatedDatabase, dropIsolatedDatabase, uniqueDbName } from "../helpers/postgres.js";

const dbName = uniqueDbName("agent_platform_access_bindings");
let database: Database;

const ACTOR = userActor({ id: "user_operator", name: "operator" });
const KEY = { catalogKind: "native_tool", catalogId: "schedule_list", scope: "org", scopeId: "org_home" };

before(async () => {
  database = await connect(await createIsolatedDatabase(dbName));
});

after(async () => {
  await database.close();
  await dropIsolatedDatabase(dbName);
});

async function accessLog(): Promise<string[]> {
  const result = await database.pool.query<{ summary: string }>(
    `SELECT summary FROM config_changes WHERE target_kind = 'access' AND target_id = $1 ORDER BY created_at, id`,
    [KEY.catalogId],
  );
  return result.rows.map((row) => row.summary);
}

test("a binding written, rewritten, and reset logs each change against its scope", async () => {
  const binding = { ...KEY, bindingId: "bind_logged", enabled: false, connectionId: null };
  const created = await writeBinding(database.pool, binding, new Date(), ACTOR);
  assert.equal(created.enabled, false);
  const updated = await writeBinding(database.pool, { ...binding, enabled: true }, new Date(), ACTOR);
  assert.equal(updated.id, created.id);
  assert.equal(updated.enabled, true);
  await writeBinding(database.pool, { ...binding, enabled: true }, new Date(), ACTOR);
  assert.equal((await resetBinding(database.pool, KEY, ACTOR))?.id, created.id);
  assert.equal(await resetBinding(database.pool, KEY, ACTOR), null);
  assert.deepEqual(await accessLog(), [
    "Turned off tool schedule_list",
    "Turned on tool schedule_list",
    "Reset tool schedule_list to inherit",
  ]);
});
