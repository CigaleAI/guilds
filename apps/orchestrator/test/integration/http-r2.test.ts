import assert from "node:assert/strict";
import { after, test } from "node:test";
import { buildApp } from "../../src/app.js";
import { connect } from "../../src/seed/connect.js";
import { NotesStore } from "../../src/notes/store.js";
import { agentScripts } from "../../src/scripts/catalog.js";
import { agentSchedules } from "../../src/schedules/service.js";
import { clearInstanceKeys, testEnv } from "../helpers/env.js";
import { connectModelProvider } from "../helpers/models.js";
import { loadJsonFixture, templatesRoot } from "../helpers/fixtures.js";
import { PlaceholderMap } from "../helpers/placeholders.js";
import { createIsolatedDatabase, dropIsolatedDatabase, uniqueDbName } from "../helpers/postgres.js";

const R2_CASES = [
  "health-ok",
  "list-users",
  "org-models-auth",
  "org-models-single-user-no-header",
  "guild-404",
  "agent-404",
  "org-404",
  "guild-invalid",
  "user-invalid",
  "org-invalid",
  "user-create",
  "org-models-missing-user",
  "foreign-guild-create",
  "guild-tenancy",
  "list-orgs",
  "org-create",
  "org-get",
  "org-patch-noop",
  "org-members",
  "org-member-add",
  "org-member-patch",
  "guild-create",
  "guild-list",
  "guild-get",
  "guild-update",
  "agent-create",
  "browser-agent-create",
  "writer-create",
  "agent-list",
  "agent-get",
  "agent-config",
  "agent-tenancy",
  "guild-files",
  "guild-file-write",
  "guild-file-read",
  "note-access-get",
  "note-access-put",
  "note-access-unknown-subject",
  "guild-reach",
  "agent-reach",
  "guild-file-escape",
  "guild-schedules",
  "agent-schedules",
  "schedule-create",
  "schedule-pause",
  "scripts-list",
  "script-create",
  "script-get",
  "agent-files",
  "agent-file-read",
  "agent-file-write",
  "agent-note-missing",
];

const recordings = loadJsonFixture<{
  cases: Array<{
    name: string;
    request: {
      method: string;
      path: string;
      headers: Record<string, string>;
      json: unknown;
      params: Record<string, string> | null;
    };
    response: {
      status: number;
      headers?: Record<string, string>;
      json?: unknown;
      text?: string;
    };
  }>;
}>("http/routes.json");

const dbName = uniqueDbName("agent_platform_r2");

after(async () => {
  await dropIsolatedDatabase(dbName);
});

test("R2 feature HTTP recordings replay against an isolated database", async () => {
  clearInstanceKeys();
  const databaseUrl = await createIsolatedDatabase(dbName);
  const env = testEnv(databaseUrl);
  const database = await connect(databaseUrl);
  const notes = new NotesStore(env.NOTES_ROOT ?? "", templatesRoot());
  await notes.ensureSystemPrompt();
  const db = database.pool;
  await connectModelProvider(db, "org_home", "openrouter");
  const scripts = agentScripts(db);
  const schedules = agentSchedules(db);
  const app = await buildApp(database, { db, notes, scripts, schedules });
  const placeholders = new PlaceholderMap();
  const byName = new Map(recordings.cases.map((item) => [item.name, item]));
  try {
    for (const name of R2_CASES) {
      const recorded = byName.get(name);
      assert.ok(recorded, `missing recording ${name}`);
      const path = placeholders.substituteText(recorded.request.path);
      const query = recorded.request.params
        ? `?${new URLSearchParams(recorded.request.params).toString()}`
        : "";
      const headers: Record<string, string> = {};
      for (const [key, value] of Object.entries(recorded.request.headers)) {
        headers[key] = placeholders.substituteText(value);
      }
      const options: {
        method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
        url: string;
        headers: Record<string, string>;
        payload?: string | object | Buffer;
      } = {
        method: recorded.request.method as "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
        url: `${path}${query}`,
        headers,
      };
      if (recorded.request.json !== null && recorded.request.json !== undefined) {
        options.payload = placeholders.substituteJson(recorded.request.json) as object;
      }
      const response = await app.inject(options);
      assert.equal(response.statusCode, recorded.response.status, `${name} status`);
      if (Object.prototype.hasOwnProperty.call(recorded.response, "json")) {
        let payload: unknown;
        try {
          payload = response.json();
        } catch {
          payload = response.body;
        }
        try {
          placeholders.compare(recorded.response.json, payload, name);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          throw new Error(`${name}: ${message}\nactual: ${JSON.stringify(payload)}`, {
            cause: error,
          });
        }
      } else if (Object.prototype.hasOwnProperty.call(recorded.response, "text")) {
        assert.equal(response.body, recorded.response.text, `${name} text`);
      }
    }
    const provenance = await app.inject({
      method: "GET",
      url: "/api/file-changes?display_path=org%2Forg_home%2Fmissing.md",
      headers: {
        "X-Guilds-User": "user_operator",
        "X-Guilds-Org": "org_home",
      },
    });
    assert.equal(provenance.statusCode, 200);
    assert.deepEqual(provenance.json(), []);

    const missingPath = await app.inject({
      method: "GET",
      url: "/api/file-changes",
      headers: {
        "X-Guilds-User": "user_operator",
        "X-Guilds-Org": "org_home",
      },
    });
    assert.equal(missingPath.statusCode, 422);
  } finally {
    await app.close();
    await database.close();
  }
});
