import assert from "node:assert/strict";
import { after, test } from "node:test";
import {
  formatColumnTimestamp,
  parseInt8,
  roundCostUsd,
  usageFields,
} from "../../src/db/codecs.js";
import { applyMigrations, createPool } from "../../src/db/client.js";
import {
  createIsolatedDatabase,
  dropIsolatedDatabase,
  uniqueDbName,
} from "../helpers/postgres.js";

const dbName = uniqueDbName("agent_platform_r1");

after(async () => {
  await dropIsolatedDatabase(dbName);
});

test("node-postgres codecs round-trip int8, timestamptz strings, and numeric cost", async () => {
  const databaseUrl = await createIsolatedDatabase(dbName);
  const pool = await createPool(databaseUrl);
  try {
    await applyMigrations(pool);
    const ints = await pool.query("SELECT 4294967303::int8 AS id");
    assert.equal(typeof ints.rows[0]?.id, "number");
    assert.equal(ints.rows[0]?.id, parseInt8("4294967303"));

    const stamps = await pool.query(
      "SELECT TIMESTAMPTZ '2026-09-13 12:00:00.123456+00' AS ts, TIMESTAMPTZ '2026-09-13 12:00:00+00' AS whole",
    );
    assert.equal(typeof stamps.rows[0]?.ts, "string");
    assert.equal(formatColumnTimestamp(String(stamps.rows[0]?.ts)), "2026-09-13T12:00:00.123456+00:00");
    assert.equal(formatColumnTimestamp(String(stamps.rows[0]?.whole)), "2026-09-13T12:00:00+00:00");

    const cost = await pool.query("SELECT '0.011984499999999999'::numeric AS cost_usd");
    assert.equal(typeof cost.rows[0]?.cost_usd, "string");
    assert.equal(roundCostUsd(String(cost.rows[0]?.cost_usd)), 0.0119845);
    assert.equal(
      usageFields({
        input_tokens: 8,
        output_tokens: 2,
        cache_read_tokens: 1,
        cost_usd: String(cost.rows[0]?.cost_usd),
        calls: 3,
        updated_at: formatColumnTimestamp(String(stamps.rows[0]?.whole)),
      }).cost_usd,
      0.0119845,
    );
  } finally {
    await pool.end();
  }
});
