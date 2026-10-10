import assert from "node:assert/strict";
import { after, test } from "node:test";
import { applyMigrations, createPool } from "../../src/db/client.js";
import { seedOperator } from "../../src/db/seed/operator.js";
import { seedSystem } from "../../src/db/seed/system.js";
import { seedTest } from "../../src/db/seed/test.js";
import {
  createIsolatedDatabase,
  dropIsolatedDatabase,
  uniqueDbName,
} from "../helpers/postgres.js";
import { classifySeed, loadSeedManifest } from "../helpers/seed-classify.js";

const dbName = uniqueDbName("agent_platform_r1");

after(async () => {
  await dropIsolatedDatabase(dbName);
});

test("system and operator seeds match the classified manifest and stay semantic-stable", async () => {
  const databaseUrl = await createIsolatedDatabase(dbName);
  const pool = await createPool(databaseUrl);
  try {
    await applyMigrations(pool);
    await seedSystem(pool);
    await seedOperator(pool);
    await seedTest(pool);
    const manifest = loadSeedManifest();
    const first = await classifySeed(pool);
    assert.deepEqual(first.connectors, manifest.system.connectors);
    assert.deepEqual(
      first.platform_native_tool_bindings,
      manifest.system.platform_native_tool_bindings,
    );
    assert.deepEqual(first.users, manifest.operator.users);
    assert.deepEqual(first.orgs, manifest.operator.orgs);
    assert.deepEqual(first.org_members, manifest.operator.org_members);
    assert.equal(first.bash_absent, manifest.system.bash_absent);
    assert.deepEqual(first.constants.expected_mcp_slugs, manifest.system.expected_mcp_slugs);
    assert.deepEqual(
      first.constants.expected_platform_native_tools,
      manifest.system.expected_platform_native_tools,
    );
    assert.deepEqual(first.constants.native_tools_constant, manifest.system.native_tools_constant);
    assert.deepEqual(first.row_counts, manifest.row_counts);

    await seedSystem(pool);
    await seedOperator(pool);
    const second = await classifySeed(pool);
    assert.deepEqual(second, first);
  } finally {
    await pool.end();
  }
});
