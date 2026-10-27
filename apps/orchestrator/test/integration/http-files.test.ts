import assert from "node:assert/strict";
import { after, test } from "node:test";
import { buildApp } from "../../src/app.js";
import { ArtifactFiles } from "../../src/artifacts/files.js";
import { ArtifactStore } from "../../src/artifacts/store.js";
import { connect } from "../../src/db/client.js";
import { MemoryBlobStore } from "../../src/lib/blob-store.js";
import { NotesStore } from "../../src/notes/store.js";
import { scriptDatabase, Scripts } from "../../src/scripts/catalog.js";
import { scheduleDatabase, Schedules } from "../../src/schedules/service.js";
import { HEX_MASTER_KEY, tempDir } from "../helpers/env.js";
import { templatesRoot } from "../helpers/fixtures.js";
import { TEST_MODEL, connectModelProvider } from "../helpers/models.js";
import { createIsolatedDatabase, dropIsolatedDatabase, uniqueDbName } from "../helpers/postgres.js";
import { insertUser } from "../../src/db/users.js";
import { insertMember } from "../../src/db/orgs.js";

const OWNER = { "X-Guilds-User": "user_operator", "X-Guilds-Org": "org_home" };
const JSON_BODY = { "content-type": "application/json" };
const BYTES = { "content-type": "application/octet-stream" };

const dbName = uniqueDbName("agent_platform_http_files");

after(async () => {
  await dropIsolatedDatabase(dbName);
});

test("operators upload, list, download, share, and delete files per level", { timeout: 60_000 }, async () => {
  process.env.SECRETS_MASTER_KEY = HEX_MASTER_KEY;
  const database = await connect(await createIsolatedDatabase(dbName));
  const notes = new NotesStore(tempDir("guilds-http-files-notes-"), templatesRoot());
  await notes.ensureSystemPrompt();
  const db = database.pool;
  await connectModelProvider(db, "org_home", "deepinfra");
  const artifacts = new ArtifactStore(database.pool, templatesRoot());
  const blobs = new MemoryBlobStore();
  const files = new ArtifactFiles(artifacts, blobs);
  const app = await buildApp(database, {
    db,
    notes,
    artifacts,
    files,
    scripts: new Scripts(scriptDatabase(db)),
    schedules: new Schedules(scheduleDatabase(db)),
  });
  const teammate = await insertUser(db, {
      userId: "user_teammate_files",
      name: "teammate-files",
      image: null,
      email: "files@example.com",
    }, new Date());
  await insertMember(db, "org_home", String(teammate.id), "member", new Date());
  const TEAMMATE = { "X-Guilds-User": String(teammate.id), "X-Guilds-Org": "org_home" };

  try {
    const guild = await app.inject({
      method: "POST",
      url: "/api/guilds",
      headers: { ...OWNER, ...JSON_BODY },
      payload: { name: "archive", visibility: "private" },
    });
    assert.equal(guild.statusCode, 201, guild.body);
    const guildId = String(guild.json().id);
    const agent = await app.inject({
      method: "POST",
      url: `/api/guilds/${guildId}/agents`,
      headers: { ...OWNER, ...JSON_BODY },
      payload: { name: "archivist", config: { model: TEST_MODEL, browser: false } },
    });
    assert.equal(agent.statusCode, 201, agent.body);
    const agentId = String(agent.json().id);

    const missingHeaders = await app.inject({
      method: "POST",
      url: `/api/guilds/${guildId}/files`,
      headers: { ...OWNER, ...BYTES, "x-filename": "report.pdf" },
      payload: Buffer.from("%PDF-1.4"),
    });
    assert.equal(missingHeaders.statusCode, 422, missingHeaders.body);
    assert.match(missingHeaders.body, /X-Filename and X-Description/);

    const uploaded = await app.inject({
      method: "POST",
      url: `/api/guilds/${guildId}/files`,
      headers: { ...OWNER, ...BYTES, "x-filename": encodeURIComponent("Q3 report.pdf"), "x-description": "The quarterly report", "x-mime": "application/pdf" },
      payload: Buffer.from("%PDF-1.4"),
    });
    assert.equal(uploaded.statusCode, 201, uploaded.body);
    const file = uploaded.json() as { id: string; display_path: string; name: string; mime: string; bytes: number; version: number };
    assert.equal(file.name, "Q3 report.pdf");
    assert.equal(file.display_path, `org/org_home/guilds/${guildId}/files/Q3 report.pdf`);
    assert.equal(file.mime, "application/pdf");
    assert.equal(file.bytes, 8);

    const listed = await app.inject({ method: "GET", url: `/api/guilds/${guildId}/files`, headers: OWNER });
    assert.equal(listed.statusCode, 200);
    assert.deepEqual((listed.json() as Array<{ id: string }>).map((item) => item.id), [file.id]);
    const agentFiles = await app.inject({ method: "GET", url: `/api/agents/${agentId}/files`, headers: OWNER });
    assert.deepEqual(agentFiles.json(), []);

    const download = await app.inject({ method: "GET", url: `/api/files/${file.id}`, headers: OWNER });
    assert.equal(download.statusCode, 200);
    assert.equal(download.headers["content-type"], "application/pdf");
    assert.equal(download.headers["x-content-type-options"], "nosniff");
    assert.match(String(download.headers["content-disposition"]), /^attachment; filename="Q3 report\.pdf"/);
    assert.equal(download.rawPayload.toString(), "%PDF-1.4");

    const html = await app.inject({
      method: "POST",
      url: `/api/org/files`,
      headers: { ...OWNER, ...BYTES, "x-filename": "page.html", "x-description": "A page" },
      payload: Buffer.from("<script>alert(1)</script>"),
    });
    assert.equal(html.statusCode, 201, html.body);
    const page = await app.inject({ method: "GET", url: `/api/files/${String(html.json().id)}`, headers: OWNER });
    assert.equal(page.headers["content-type"], "text/html");
    assert.match(String(page.headers["content-disposition"]), /^attachment;/);

    // A member who cannot see the private guild does not see its file, by list or by id.
    const hiddenList = await app.inject({ method: "GET", url: `/api/guilds/${guildId}/files`, headers: TEAMMATE });
    assert.equal(hiddenList.statusCode, 404);
    const hiddenFile = await app.inject({ method: "GET", url: `/api/files/${file.id}`, headers: TEAMMATE });
    assert.equal(hiddenFile.statusCode, 404);
    const hiddenAccess = await app.inject({ method: "GET", url: `/api/files/${file.id}/access`, headers: TEAMMATE });
    assert.equal(hiddenAccess.statusCode, 404);

    const access = await app.inject({ method: "GET", url: `/api/files/${file.id}/access`, headers: OWNER });
    assert.equal(access.statusCode, 200, access.body);
    assert.deepEqual(
      (access.json() as { subjects: Array<{ type: string; id: string; mode: string }> }).subjects.map((entry) => [entry.type, entry.id, entry.mode]),
      [["guild", guildId, "write"]],
    );
    const replaced = await app.inject({
      method: "PUT",
      url: `/api/files/${file.id}/access`,
      headers: { ...OWNER, ...JSON_BODY },
      payload: { subjects: [{ type: "guild", id: guildId, mode: "write" }, { type: "org", id: "org_home", mode: "read" }] },
    });
    assert.equal(replaced.statusCode, 200, replaced.body);

    const replacedFile = await app.inject({
      method: "POST",
      url: `/api/guilds/${guildId}/files`,
      headers: { ...OWNER, ...BYTES, "x-filename": encodeURIComponent("Q3 report.pdf"), "x-description": "The quarterly report, final" },
      payload: Buffer.from("%PDF-1.4 final"),
    });
    assert.equal(replacedFile.statusCode, 201, replacedFile.body);
    assert.equal((replacedFile.json() as { id: string; version: number }).id, file.id);
    assert.equal((replacedFile.json() as { version: number }).version, 2);

    const removed = await app.inject({ method: "DELETE", url: `/api/files/${file.id}`, headers: OWNER });
    assert.equal(removed.statusCode, 204);
    const gone = await app.inject({ method: "GET", url: `/api/files/${file.id}`, headers: OWNER });
    assert.equal(gone.statusCode, 404);
    assert.equal(blobs.objects.size, 1, "only the organisation file's bytes remain");
  } finally {
    await app.close();
    await database.close();
  }
});
