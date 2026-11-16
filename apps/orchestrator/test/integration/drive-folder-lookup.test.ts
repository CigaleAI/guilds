import assert from "node:assert/strict";
import { after, test } from "node:test";
import { buildApp } from "../../src/app.js";
import { DRIVE_FOLDER_MIME } from "../../src/connectors/drive/folder.js";
import { DRIVE_PATH_UNAVAILABLE } from "../../src/connectors/drive/path.js";
import { encryptPayload } from "../../src/credentials/crypto.js";
import { connectMcp, replaceMcpTools } from "../../src/db/mcp.js";
import { insertMember } from "../../src/db/orgs.js";
import { insertUser } from "../../src/db/users.js";
import { mcpPool } from "../../src/mcp/pool.js";
import type { FetchFn } from "../../src/net/http.js";
import { NotesStore } from "../../src/notes/store.js";
import { agentSchedules } from "../../src/schedules/service.js";
import { agentScripts } from "../../src/scripts/catalog.js";
import { connect } from "../../src/seed/connect.js";
import { projectConnectors } from "../../src/seed/system.js";
import { HEX_MASTER_KEY, tempDir } from "../helpers/env.js";
import { templatesRoot } from "../helpers/fixtures.js";
import { mockFetch, type MockResult } from "../helpers/http.js";
import { TEST_MODEL, connectModelProvider } from "../helpers/models.js";
import { createIsolatedDatabase, dropIsolatedDatabase, uniqueDbName } from "../helpers/postgres.js";

const AUTH = { "X-Guilds-User": "user_operator", "X-Guilds-Org": "org_home", "content-type": "application/json" };
const OUTSIDER = { "X-Guilds-User": "user_drive_outsider", "content-type": "application/json" };
const REPORTS = "1ReportsFolderId_abcdefghij";
const ARCHIVE = "1ArchiveFolderId_abcdefghij";
const REPORTS_FILE = "1ReportsQ3File_abcdefghijkl";
const ARCHIVE_FILE = "1ArchiveOldFile_abcdefghijk";
const dbName = uniqueDbName("agent_platform_drive_folder_lookup");
const ownersDbName = uniqueDbName("agent_platform_drive_folder_owners");

after(async () => {
  await dropIsolatedDatabase(dbName);
  await dropIsolatedDatabase(ownersDbName);
});

type FakeFolder = { name: string; parents?: string[] };

/**
 * A synthetic Drive: My Drive holds Projects, which holds Reports and Archive, each holding one file.
 * Every request it gets is kept in `requests`; a request for a file in `unreachable` fails before Drive answers.
 */
function syntheticDrive() {
  const folders: Record<string, FakeFolder> = {
    my_root: { name: "My Drive" },
    projects: { name: "Projects", parents: ["my_root"] },
    [REPORTS]: { name: "Reports", parents: ["projects"] },
    [ARCHIVE]: { name: "Archive", parents: ["projects"] },
    [REPORTS_FILE]: { name: "q3.txt", parents: [REPORTS] },
    [ARCHIVE_FILE]: { name: "old.txt", parents: [ARCHIVE] },
  };
  const requests: { method: string; url: string }[] = [];
  const unreachable = new Set<string>();
  let failing = false;
  const answer = mockFetch((url, init): MockResult => {
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
  const client: FetchFn = async (url, init) => {
    const path = new URL(url).pathname;
    if (unreachable.has(decodeURIComponent(path.slice(path.lastIndexOf("/") + 1)))) {
      requests.push({ method: init?.method ?? "GET", url });
      throw new TypeError("fetch failed");
    }
    return answer(url, init);
  };
  return {
    client,
    folders,
    unreachable,
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
  await replaceMcpTools(
    db,
    login.id,
    [{ remote_name: "get_file_metadata", namespaced_name: "drive_get_file_metadata", description: "", input_schema: { type: "object" } }],
    new Date(),
  );
  const readMetadata = (fileId: string) =>
    app.inject({
      method: "POST",
      url: `/api/mcp/connections/${login.id}/call`,
      headers: AUTH,
      payload: { tool: "get_file_metadata", arguments: { fileId } },
    });
  try {
    const saved = await lookup(REPORTS);
    assert.equal(saved.statusCode, 200, saved.body);
    assert.deepEqual(saved.json().options, [{ value: REPORTS, label: "Reports", detail: "My Drive / Projects / Reports" }]);

    const insideSaved = await readMetadata(REPORTS_FILE);
    assert.equal(insideSaved.statusCode, 200, insideSaved.body);
    assert.match(insideSaved.json().content, /q3\.txt/);
    const outsideSaved = await readMetadata(ARCHIVE_FILE);
    assert.notEqual(outsideSaved.statusCode, 200, outsideSaved.body);
    assert.match(outsideSaved.body, /limited to the connected folder/);

    drive.unreachable.add("projects");
    const ancestorUnreachable = await lookup(REPORTS);
    assert.equal(ancestorUnreachable.statusCode, 200, ancestorUnreachable.body);
    assert.deepEqual(ancestorUnreachable.json().options, [{ value: REPORTS, label: "Reports", detail: DRIVE_PATH_UNAVAILABLE }]);
    drive.unreachable.clear();
    drive.folders.projects = { name: "  ", parents: ["my_root"] };
    const ancestorUnnamed = await lookup(REPORTS);
    assert.equal(ancestorUnnamed.statusCode, 200, ancestorUnnamed.body);
    assert.deepEqual(ancestorUnnamed.json().options, [{ value: REPORTS, label: "Reports", detail: DRIVE_PATH_UNAVAILABLE }]);
    drive.folders.projects = { name: "Projects", parents: ["my_root"] };
    assert.deepEqual(await storedSettings(), { folder_id: REPORTS });

    const searched = await lookup("Reports");
    assert.equal(searched.statusCode, 200, searched.body);
    assert.deepEqual(searched.json().options, [{ value: REPORTS, label: "Reports", detail: "My Drive / Projects / Reports" }]);

    assert.equal((await lookup(REPORTS, OUTSIDER)).statusCode, 404);
    assert.equal((await putSettings({ folder_id: ARCHIVE }, OUTSIDER)).statusCode, 404);

    for (const refusedSettings of [{}, { folder_id: "" }, { folder_id: 42 }]) {
      const cleared = await putSettings(refusedSettings);
      assert.equal(cleared.statusCode, 422, cleared.body);
      assert.deepEqual(await storedSettings(), { folder_id: REPORTS });
    }

    const replaced = await putSettings({ folder_id: ARCHIVE });
    assert.equal(replaced.statusCode, 200, replaced.body);
    assert.deepEqual(replaced.json().settings, { folder_id: ARCHIVE });
    assert.equal(replaced.json().account_hint, "Archive");
    assert.equal((await readMetadata(ARCHIVE_FILE)).statusCode, 200);
    assert.match((await readMetadata(REPORTS_FILE)).body, /limited to the connected folder/);

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

test("a guild's or an agent's Drive login is looked up and saved only by those who see its owner, and an inherited one by the organisation's members", { timeout: 60_000 }, async () => {
  process.env.SECRETS_MASTER_KEY = HEX_MASTER_KEY;
  const database = await connect(await createIsolatedDatabase(ownersDbName));
  await projectConnectors(database.pool);
  const db = database.pool;
  await connectModelProvider(db, "org_home", "deepinfra");
  await insertUser(db, { userId: OUTSIDER["X-Guilds-User"], name: "drive-outsider", image: null, email: "drive-outsider@example.com" }, new Date());
  const member = await insertUser(db, { userId: "user_drive_member", name: "drive-member", image: null, email: "drive-member@example.com" }, new Date());
  await insertMember(db, { org_id: "org_home", user_id: member.id, role: "member" }, new Date());
  const MEMBER = { "X-Guilds-User": member.id, "X-Guilds-Org": "org_home", "content-type": "application/json" };
  const notes = new NotesStore(tempDir("guilds-drive-owners-notes-"), templatesRoot());
  await notes.ensureSystemPrompt();
  const mcp = mcpPool(db);
  mcp.fetchFn = syntheticDrive().client;
  const app = await buildApp(database, {
    db,
    notes,
    scripts: agentScripts(db),
    schedules: agentSchedules(db),
    mcp,
    masterKey: Buffer.from(HEX_MASTER_KEY, "hex"),
  });
  const created = async (url: string, payload: object) => {
    const response = await app.inject({ method: "POST", url, headers: AUTH, payload });
    assert.ok(response.statusCode < 300, `${url}: ${response.statusCode} ${response.body}`);
    return String(response.json().id);
  };
  const [ciphertext, nonce] = encryptPayload({ access_token: "tok" }, Buffer.from(HEX_MASTER_KEY, "hex"));
  const driveLogin = async (ownerScope: "org" | "guild" | "agent", ownerId: string) =>
    (
      await connectMcp(
        db,
        {
          connectionId: `conn_drive_${ownerScope}`,
          bindingId: `bind_drive_${ownerScope}`,
          serverId: "mcp_drive",
          ownerScope,
          ownerId,
          ciphertext,
          nonce,
          status: "connected",
          accountHint: "Reports",
          settings: { folder_id: REPORTS },
        },
        new Date(),
      )
    ).id;
  const lookup = (id: string, headers: Record<string, string>) =>
    app.inject({ method: "GET", url: `/api/mcp/connections/${id}/lookup?property=folder_id&q=${REPORTS}`, headers });
  const putSettings = (id: string, folderId: string, headers: Record<string, string>) =>
    app.inject({ method: "PUT", url: `/api/mcp/connections/${id}/settings`, headers, payload: { settings: { folder_id: folderId } } });
  const storedSettings = async (id: string) =>
    (await app.inject({ method: "GET", url: `/api/mcp/connections/${id}`, headers: AUTH })).json().settings;
  try {
    const vault = await created("/api/guilds", { name: "drive-vault", visibility: "private" });
    const keeper = await created(`/api/guilds/${vault}/agents`, { name: "keeper", config: { model: TEST_MODEL, browser: false } });
    const owned = { guild: await driveLogin("guild", vault), agent: await driveLogin("agent", keeper) };
    for (const [scope, id] of Object.entries(owned)) {
      for (const refused of [MEMBER, OUTSIDER]) {
        assert.equal((await lookup(id, refused)).statusCode, 404, `${scope} lookup by ${refused["X-Guilds-User"]}`);
        assert.equal((await putSettings(id, ARCHIVE, refused)).statusCode, 404, `${scope} save by ${refused["X-Guilds-User"]}`);
      }
      assert.deepEqual(await storedSettings(id), { folder_id: REPORTS }, `${scope} keeps its folder`);
      const seen = await lookup(id, AUTH);
      assert.equal(seen.statusCode, 200, seen.body);
      assert.deepEqual(seen.json().options, [{ value: REPORTS, label: "Reports", detail: "My Drive / Projects / Reports" }]);
      const saved = await putSettings(id, ARCHIVE, AUTH);
      assert.equal(saved.statusCode, 200, saved.body);
      assert.deepEqual(await storedSettings(id), { folder_id: ARCHIVE }, `${scope} saves a picked folder`);
    }

    const inherited = await driveLogin("org", "org_home");
    const memberLookup = await lookup(inherited, MEMBER);
    assert.equal(memberLookup.statusCode, 200, memberLookup.body);
    assert.deepEqual(memberLookup.json().options, [{ value: REPORTS, label: "Reports", detail: "My Drive / Projects / Reports" }]);
    assert.equal((await lookup(inherited, OUTSIDER)).statusCode, 404);
    assert.equal((await putSettings(inherited, ARCHIVE, OUTSIDER)).statusCode, 404);
    assert.deepEqual(await storedSettings(inherited), { folder_id: REPORTS });
    const memberSave = await putSettings(inherited, ARCHIVE, MEMBER);
    assert.equal(memberSave.statusCode, 200, memberSave.body);
    assert.deepEqual(await storedSettings(inherited), { folder_id: ARCHIVE });
  } finally {
    await app.close();
    await database.close();
  }
});
