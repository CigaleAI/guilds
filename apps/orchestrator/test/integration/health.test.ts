import assert from "node:assert/strict";
import { after, test } from "node:test";
import { buildApp } from "../../src/app.js";
import { connect } from "../../src/seed/connect.js";
import {
  createIsolatedDatabase,
  dropIsolatedDatabase,
  uniqueDbName,
} from "../helpers/postgres.js";

const dbName = uniqueDbName("agent_platform_r1");
const schemaDbName = uniqueDbName("agent_platform_r1_schema");

after(async () => {
  await dropIsolatedDatabase(dbName);
  await dropIsolatedDatabase(schemaDbName);
});

test("migrates, seeds, and serves /health against an isolated database", async () => {
  const databaseUrl = await createIsolatedDatabase(dbName);
  const database = await connect(databaseUrl);
  const app = await buildApp(database);
  try {
    const response = await app.inject({ method: "GET", url: "/health" });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json(), { status: "ok" });
  } finally {
    await app.close();
    await database.close();
  }
});

test("a request its route's schema refuses is a 422 naming the value at fault", async () => {
  const database = await connect(await createIsolatedDatabase(schemaDbName));
  const app = await buildApp(database);
  try {
    const response = await app.inject({ method: "GET", url: "/avatars/clay.svg?seed=a&seed=b" });
    assert.equal(response.statusCode, 422);
    assert.deepEqual(response.json(), {
      detail: [
        { type: "type", loc: ["querystring", "seed"], msg: "must be string", input: ["a", "b"] },
      ],
    });
  } finally {
    await app.close();
    await database.close();
  }
});
