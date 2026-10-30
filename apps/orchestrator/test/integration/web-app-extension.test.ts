import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { buildApp } from "../../src/app.js";
import { connect } from "../../src/seed/connect.js";
import { NotesStore } from "../../src/notes/store.js";
import { agentSchedules } from "../../src/schedules/service.js";
import { agentScripts } from "../../src/scripts/catalog.js";
import { HEX_MASTER_KEY, tempDir } from "../helpers/env.js";
import { templatesRoot } from "../helpers/fixtures.js";
import { createIsolatedDatabase, dropIsolatedDatabase, uniqueDbName } from "../helpers/postgres.js";

const dbName = uniqueDbName("agent_platform_web_app");
const dist = mkdtempSync(path.join(tmpdir(), "extension-web-"));
writeFileSync(path.join(dist, "index.html"), "<!doctype html><title>extension build</title><div id=root></div>");

after(async () => {
  rmSync(dist, { recursive: true, force: true });
  await dropIsolatedDatabase(dbName);
});

test("an extension's build of the operator app is served in place of core's", { timeout: 60_000 }, async () => {
  process.env.SECRETS_MASTER_KEY = HEX_MASTER_KEY;
  const database = await connect(await createIsolatedDatabase(dbName));
  const notes = new NotesStore(tempDir("guilds-web-app-"), templatesRoot());
  await notes.ensureSystemPrompt();
  const db = database.pool;
  const deps = { db, notes, scripts: agentScripts(db), schedules: agentSchedules(db) };
  const app = await buildApp(database, deps, [{ name: "extension", webApp: dist }]);
  try {
    for (const url of ["/", "/settings", "/login"]) {
      const page = await app.inject({ method: "GET", url, headers: { accept: "text/html" } });
      assert.equal(page.statusCode, 200, url);
      assert.match(page.body, /extension build/, url);
    }
    const api = await app.inject({ method: "GET", url: "/api/nothing", headers: { accept: "text/html" } });
    assert.equal(api.statusCode, 404);
  } finally {
    await app.close();
    await database.close();
  }
});
