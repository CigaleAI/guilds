import assert from "node:assert/strict";
import { after, test } from "node:test";
import { buildApp } from "../../src/app.js";
import { DRIVE_FOLDER_MIME } from "../../src/connectors/drive/folder.js";
import { encryptPayload } from "../../src/credentials/crypto.js";
import { connectMcp } from "../../src/db/mcp.js";
import { insertUser } from "../../src/db/users.js";
import { mcpPool } from "../../src/mcp/pool.js";
import { NotesStore } from "../../src/notes/store.js";
import { agentSchedules } from "../../src/schedules/service.js";
import { agentScripts } from "../../src/scripts/catalog.js";
import { connect } from "../../src/seed/connect.js";
import { projectConnectors } from "../../src/seed/system.js";
import { HEX_MASTER_KEY, tempDir } from "../helpers/env.js";
import { templatesRoot } from "../helpers/fixtures.js";
import { mockFetch, type MockResult } from "../helpers/http.js";
import { createIsolatedDatabase, dropIsolatedDatabase, uniqueDbName } from "../helpers/postgres.js";

const AUTH = { "X-Guilds-User": "user_operator", "X-Guilds-Org": "org_home", "content-type": "application/json" };
const OUTSIDER = { "X-Guilds-User": "user_drive_outsider", "content-type": "application/json" };
const REPORTS = "1ReportsFolderId_abcdefghij";
const ARCHIVE = "1ArchiveFolderId_abcdefghij";
const dbName = uniqueDbName("agent_platform_drive_folder_lookup");

after(async () => {
  await dropIsolatedDatabase(dbName);
});

type FakeFolder = { name: string; parents?: string[] };

/** A synthetic Drive: My Drive holds Projects, which holds Reports and Archive. Every request it gets is kept in `requests`. */
function syntheticDrive() {
  const folders: Record<string, FakeFolder> = {
    my_root: { name: "My Drive" },
    projects: { name: "Projects", parents: ["my_root"] },
    [REPORTS]: { name: "Reports", parents: ["projects"] },
    [ARCHIVE]: { name: "Archive", parents: ["projects"] },
  };
  const requests: { method: string; url: string }[] = [];
  let failing = false;
  const client = mockFetch((url, init): MockResult => {
    requests.push({ method: init?.method ?? "GET", url });
    if (failing) {
      return { status: 500, json: { error: { message: "backend error" } } };
    }
    const parsed = new URL(url);
    const id = decodeURIComponent(parsed.pathname.slice(parsed.pathname.lastIndexOf("/") + 1));
    if (id === "files") {
      const files = Object.entries(folders)
        .filter(([, folder]) => folder.name === "Reports")
        .map(([fileId, folder]) => ({ id: fileId, name: folder.name }));
      return { status: 200, json: { files } };
    }
    if (id === "root") {
      return { status: 200, json: { id: "my_root" } };
    }
    const folder = folders[id];
    return folder ? { status: 200, json: { id, mimeType: DRIVE_FOLDER_MIME, ...folder } } : { status: 404 };
  });
  return {
    client,
    requests,
    fail: () => {
      failing = true;
    },
  };
}

test("a Drive login looks up its saved folder's path through its own login, and keeps its folder until a valid one is saved", { timeout: 60_000 }, async () => {
  process.env.SECRETS_MASTER_KEY = HEX_MASTER_KEY;
  const database = await connect(await createIsolatedDatabase(dbName));
  await projectConnectors(database.pool);
  const db = database.pool;
  await insertUser(db, { userId: OUTSIDER["X-Guilds-User"], name: "drive-outsider", image: null, email: "drive-outsider@example.com" }, new Date());
  const notes = new NotesStore(tempDir("guilds-drive-lookup-notes-"), templatesRoot());
  await notes.ensureSystemPrompt();
  const mcp = mcpPool(db);
  const drive = syntheticDrive();
  mcp.fetchFn = drive.client;
  const [ciphertext, nonce] = encryptPayload({ access_token: "tok" }, Buffer.from(HEX_MASTER_KEY, "hex"));
  const login = await connectMcp(
    db,
    {
      connectionId: "conn_drive_lookup",
      bindingId: "bind_drive_lookup",
      serverId: "mcp_drive",
      ownerScope: "org",
      ownerId: "org_home",
      ciphertext,
      nonce,
      status: "connected",
      accountHint: "Reports",
      settings: { folder_id: REPORTS },
    },
    new Date(),
  );
  const app = await buildApp(database, {
    db,
    notes,
    scripts: agentScripts(db),
    schedules: agentSchedules(db),
    mcp,
    masterKey: Buffer.from(HEX_MASTER_KEY, "hex"),
  });
  const lookup = (q: string, headers: Record<string, string> = AUTH) =>
    app.inject({
      method: "GET",
      url: `/api/mcp/connections/${login.id}/lookup?property=folder_id&q=${encodeURIComponent(q)}`,
      headers,
    });
  const putSettings = (settings: object, headers: Record<string, string> = AUTH) =>
    app.inject({ method: "PUT", url: `/api/mcp/connections/${login.id}/settings`, headers, payload: { settings } });
  const storedSettings = async () =>
    (await app.inject({ method: "GET", url: `/api/mcp/connections/${login.id}`, headers: AUTH })).json().settings;
  try {
    const saved = await lookup(REPORTS);
    assert.equal(saved.statusCode, 200, saved.body);
    assert.deepEqual(saved.json().options, [{ value: REPORTS, label: "Reports", detail: "My Drive / Projects / Reports" }]);

    const searched = await lookup("Reports");
    assert.equal(searched.statusCode, 200, searched.body);
    assert.deepEqual(searched.json().options, [{ value: REPORTS, label: "Reports", detail: "My Drive / Projects / Reports" }]);

    assert.equal((await lookup(REPORTS, OUTSIDER)).statusCode, 404);
    assert.equal((await putSettings({ folder_id: ARCHIVE }, OUTSIDER)).statusCode, 404);

    const cleared = await putSettings({});
    assert.equal(cleared.statusCode, 422, cleared.body);
    assert.deepEqual(await storedSettings(), { folder_id: REPORTS });

    const replaced = await putSettings({ folder_id: ARCHIVE });
    assert.equal(replaced.statusCode, 200, replaced.body);
    assert.deepEqual(replaced.json().settings, { folder_id: ARCHIVE });
    assert.equal(replaced.json().account_hint, "Archive");

    drive.fail();
    const failed = await lookup(ARCHIVE);
    assert.notEqual(failed.statusCode, 200, failed.body);
    const refused = await putSettings({ folder_id: REPORTS });
    assert.notEqual(refused.statusCode, 200, refused.body);
    assert.deepEqual(await storedSettings(), { folder_id: ARCHIVE });

    assert.deepEqual(
      drive.requests.filter((request) => request.method !== "GET" || /trash|delete/i.test(new URL(request.url).pathname)),
      [],
    );
  } finally {
    await app.close();
    await database.close();
  }
});
