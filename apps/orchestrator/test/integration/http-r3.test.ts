import assert from "node:assert/strict";
import { after, test } from "node:test";
import { buildApp } from "../../src/app.js";
import { decodeMasterKey } from "../../src/config/index.js";
import { connect } from "../../src/db/client.js";
import { Repositories } from "../../src/db/repositories.js";
import { McpPool } from "../../src/mcp/index.js";
import { NotesStore } from "../../src/notes/store.js";
import { Scripts } from "../../src/scripts/catalog.js";
import { Schedules } from "../../src/schedules/service.js";
import { HEX_MASTER_KEY, clearConnectorKeys, testEnv } from "../helpers/env.js";
import { connectModelProvider } from "../helpers/models.js";
import { loadJsonFixture, templatesRoot } from "../helpers/fixtures.js";
import { PlaceholderMap } from "../helpers/placeholders.js";
import {
  createIsolatedDatabase,
  dropIsolatedDatabase,
  uniqueDbName,
} from "../helpers/postgres.js";

const R3_CASES = [
  "oauth-cancelled",
  "oauth-session-expired",
  "secret-404",
  "connection-404",
  "secret-create",
  "secret-list",
  "secret-get",
  "secret-update",
  "mcp-servers",
  "mcp-connections",
  "mcp-connect-missing-key",
  "secret-delete",
  "connection-delete-404",
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

const dbName = uniqueDbName("agent_platform_r3");

after(async () => {
  await dropIsolatedDatabase(dbName);
});

test("R3 feature HTTP recordings replay against an isolated database", async () => {
  clearConnectorKeys();
  const databaseUrl = await createIsolatedDatabase(dbName);
  const env = testEnv(databaseUrl);
  const database = await connect(databaseUrl);
  const notes = new NotesStore(env.NOTES_ROOT ?? "", templatesRoot(), "notes");
  await notes.ensureSystemPrompt();
  const repo = new Repositories(database.pool);
  await connectModelProvider(repo, "org_home", "openrouter");
  const scripts = new Scripts(repo);
  const schedules = new Schedules(repo, notes);
  const app = await buildApp(database, {
    repo,
    notes,
    scripts,
    schedules,
    masterKey: decodeMasterKey(HEX_MASTER_KEY),
    mcp: new McpPool(),
  });
  const placeholders = new PlaceholderMap();
  const byName = new Map(recordings.cases.map((item) => [item.name, item]));
  try {
    for (const name of R3_CASES) {
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
  } finally {
    await app.close();
    await database.close();
  }
});
