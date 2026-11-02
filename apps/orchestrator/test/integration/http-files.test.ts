import assert from "node:assert/strict";
import { after, test } from "node:test";
import { buildApp } from "../../src/app.js";
import { ArtifactFiles } from "../../src/artifacts/files.js";
import type { SharedFileChange } from "../../src/artifacts/operator-files.js";
import { artifactStore } from "../../src/artifacts/store.js";
import { connect } from "../../src/seed/connect.js";
import { MemoryBlobStore } from "../../src/lib/blob-store.js";
import { NotesStore } from "../../src/notes/store.js";
import { agentScripts } from "../../src/scripts/catalog.js";
import { agentSchedules } from "../../src/schedules/service.js";
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

test("operators upload with a starting row, list per page, download, share, and delete files", { timeout: 60_000 }, async () => {
  process.env.SECRETS_MASTER_KEY = HEX_MASTER_KEY;
  const database = await connect(await createIsolatedDatabase(dbName));
  const notes = new NotesStore(tempDir("guilds-http-files-notes-"), templatesRoot());
  await notes.ensureSystemPrompt();
  const db = database.pool;
  await connectModelProvider(db, "org_home", "deepinfra");
  const artifacts = artifactStore(database.pool, templatesRoot());
  const blobs = new MemoryBlobStore();
  const files = new ArtifactFiles(artifacts, blobs);
  const published: Array<[string, SharedFileChange]> = [];
  const app = await buildApp(database, {
    db,
    notes,
    artifacts,
    files,
    publishSharedFileChanged: async (guildId, change) => {
      published.push([guildId, change]);
    },
    scripts: agentScripts(db),
    schedules: agentSchedules(db),
  });
  const teammate = await insertUser(db, {
      userId: "user_teammate_files",
      name: "teammate-files",
      image: null,
      email: "files@example.com",
    }, new Date());
  await insertMember(
    db,
    { org_id: "org_home", user_id: String(teammate.id), role: "member" },
    new Date(),
  );
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
      url: "/api/org/files",
      headers: { ...OWNER, ...BYTES, "x-filename": "report.pdf" },
      payload: Buffer.from("%PDF-1.4"),
    });
    assert.equal(missingHeaders.statusCode, 422, missingHeaders.body);
    assert.match(missingHeaders.body, /X-Filename and X-Description/);
    const partialAccess = await app.inject({
      method: "POST",
      url: "/api/org/files",
      headers: { ...OWNER, ...BYTES, "x-filename": "report.pdf", "x-description": "d", "x-access-type": "guild" },
      payload: Buffer.from("%PDF-1.4"),
    });
    assert.equal(partialAccess.statusCode, 422, partialAccess.body);
    assert.match(partialAccess.body, /X-Access-Type, X-Access-Id, and X-Access-Mode go together/);
    const perGuildUpload = await app.inject({
      method: "POST",
      url: `/api/guilds/${guildId}/files`,
      headers: { ...OWNER, ...BYTES, "x-filename": "report.pdf", "x-description": "d" },
      payload: Buffer.from("%PDF-1.4"),
    });
    assert.equal(perGuildUpload.statusCode, 404, "files are uploaded to the organisation alone");

    const guildRow = { "x-access-type": "guild", "x-access-id": guildId, "x-access-mode": "write" };
    const uploaded = await app.inject({
      method: "POST",
      url: "/api/org/files",
      headers: {
        ...OWNER,
        ...BYTES,
        ...guildRow,
        "x-filename": encodeURIComponent("Q3 report.pdf"),
        "x-description": "The quarterly report",
        "x-mime": "application/pdf",
      },
      payload: Buffer.from("%PDF-1.4"),
    });
    assert.equal(uploaded.statusCode, 201, uploaded.body);
    const file = uploaded.json() as { id: string; display_path: string; name: string; mime: string; bytes: number; version: number };
    assert.equal(file.name, "Q3 report.pdf");
    assert.equal(file.display_path, "org/org_home/files/Q3 report.pdf");
    assert.equal(file.mime, "application/pdf");
    assert.equal(file.bytes, 8);
    assert.equal("level" in file, false);

    const listed = await app.inject({ method: "GET", url: `/api/guilds/${guildId}/files`, headers: OWNER });
    assert.equal(listed.statusCode, 200);
    const guildPage = listed.json() as { own: unknown[]; shared: Array<{ id: string; home: null; viewer_mode: string }> };
    assert.deepEqual(guildPage.own, [], "an upload that names no home is the organisation's");
    assert.deepEqual(guildPage.shared.map((item) => [item.id, item.home, item.viewer_mode]), [[file.id, null, "all_write"]]);
    assert.equal("access" in (guildPage.shared[0] ?? {}), false);
    const agentFiles = await app.inject({ method: "GET", url: `/api/agents/${agentId}/files`, headers: OWNER });
    assert.deepEqual(
      (agentFiles.json() as { shared: Array<{ id: string; viewer_mode: string }> }).shared.map((item) => [item.id, item.viewer_mode]),
      [[file.id, "write"]],
      "the guild's row reaches its agent",
    );

    const download = await app.inject({ method: "GET", url: `/api/files/${file.id}`, headers: OWNER });
    assert.equal(download.statusCode, 200);
    assert.equal(download.headers["content-type"], "application/pdf");
    assert.equal(download.headers["x-content-type-options"], "nosniff");
    assert.equal(download.headers["cache-control"], "private, no-store");
    assert.match(String(download.headers["content-disposition"]), /^attachment; filename="Q3 report\.pdf"/);
    assert.equal(download.rawPayload.toString(), "%PDF-1.4");

    const html = await app.inject({
      method: "POST",
      url: `/api/org/files`,
      headers: { ...OWNER, ...BYTES, "x-filename": "page.html", "x-description": "A page" },
      payload: Buffer.from("<script>alert(1)</script>"),
    });
    assert.equal(html.statusCode, 201, html.body);
    const htmlId = String(html.json().id);
    const page = await app.inject({ method: "GET", url: `/api/files/${htmlId}`, headers: OWNER });
    assert.equal(page.headers["content-type"], "text/html");
    assert.match(String(page.headers["content-disposition"]), /^attachment;/);
    const htmlAccess = await app.inject({ method: "GET", url: `/api/files/${htmlId}/access`, headers: OWNER });
    assert.deepEqual(
      (htmlAccess.json() as { subjects: Array<{ type: string; id: string; mode: string }> }).subjects.map((entry) => [entry.type, entry.id, entry.mode]),
      [["org", "org_home", "write"]],
      "an upload that names no row is written by the organisation",
    );
    const orgFiles = await app.inject({ method: "GET", url: `/api/org/files`, headers: OWNER });
    assert.equal(orgFiles.statusCode, 200);
    assert.deepEqual(
      Object.fromEntries((orgFiles.json() as Array<{ id: string; viewer_mode: string }>).map((item) => [item.id, item.viewer_mode])),
      { [file.id]: "some", [htmlId]: "all_write" },
    );
    const guildAfter = await app.inject({ method: "GET", url: `/api/guilds/${guildId}/files`, headers: OWNER });
    assert.deepEqual(
      (guildAfter.json() as { shared: Array<{ id: string }> }).shared.map((item) => item.id).sort(),
      [file.id, htmlId].sort(),
      "a guild page shares what names the guild and what the organisation's row reaches",
    );

    // A member who does not operate the private guild does not see a file only the guild's row reaches, by list or by id.
    const hiddenList = await app.inject({ method: "GET", url: `/api/guilds/${guildId}/files`, headers: TEAMMATE });
    assert.equal(hiddenList.statusCode, 404);
    const teammateOrg = await app.inject({ method: "GET", url: "/api/org/files", headers: TEAMMATE });
    assert.deepEqual((teammateOrg.json() as Array<{ id: string }>).map((item) => item.id), [htmlId]);
    const hiddenFile = await app.inject({ method: "GET", url: `/api/files/${file.id}`, headers: TEAMMATE });
    assert.equal(hiddenFile.statusCode, 404);
    const hiddenAccess = await app.inject({ method: "GET", url: `/api/files/${file.id}/access`, headers: TEAMMATE });
    assert.equal(hiddenAccess.statusCode, 404);

    const access = await app.inject({ method: "GET", url: `/api/files/${file.id}/access`, headers: OWNER });
    assert.equal(access.statusCode, 200, access.body);
    assert.deepEqual(access.json(), {
      subjects: [{ type: "guild", id: guildId, name: "archive", mode: "write", guild_id: guildId, guild_name: "archive" }],
    });
    const replaced = await app.inject({
      method: "PUT",
      url: `/api/files/${file.id}/access`,
      headers: { ...OWNER, ...JSON_BODY },
      payload: { subjects: [{ type: "guild", id: guildId, mode: "write" }, { type: "org", id: "org_home", mode: "read" }] },
    });
    assert.equal(replaced.statusCode, 200, replaced.body);
    const shared = await app.inject({ method: "GET", url: `/api/files/${file.id}`, headers: TEAMMATE });
    assert.equal(shared.statusCode, 200, "a row outside the private guild makes the file visible");
    const unlisted = await app.inject({
      method: "PUT",
      url: `/api/files/${file.id}/access`,
      headers: { ...OWNER, ...JSON_BODY },
      payload: { subjects: "all" },
    });
    assert.equal(unlisted.statusCode, 422);
    assert.deepEqual(unlisted.json().detail[0].loc, ["body", "subjects"]);
    const unmoded = await app.inject({
      method: "PUT",
      url: `/api/files/${file.id}/access`,
      headers: { ...OWNER, ...JSON_BODY },
      payload: { subjects: [{ type: "guild", id: guildId }] },
    });
    assert.equal(unmoded.statusCode, 422);
    assert.deepEqual(unmoded.json().detail[0].loc, ["body", "subjects", "0", "mode"]);

    const replacedFile = await app.inject({
      method: "POST",
      url: "/api/org/files",
      headers: { ...OWNER, ...BYTES, "x-filename": encodeURIComponent("Q3 report.pdf"), "x-description": "The quarterly report, final" },
      payload: Buffer.from("%PDF-1.4 final"),
    });
    assert.equal(replacedFile.statusCode, 201, replacedFile.body);
    assert.equal((replacedFile.json() as { id: string; version: number }).id, file.id);
    assert.equal((replacedFile.json() as { version: number }).version, 2);

    // X-Expected-Version: 0 asks for a new file, any other value for the live version, none for no check.
    const replace = (headers: Record<string, string>, name = "Q3 report.pdf") =>
      app.inject({
        method: "POST",
        url: "/api/org/files",
        headers: { ...OWNER, ...BYTES, "x-filename": encodeURIComponent(name), "x-description": "The quarterly report", ...headers },
        payload: Buffer.from("%PDF-1.4 again"),
      });
    const exists = await replace({ "x-expected-version": "0" });
    assert.equal(exists.statusCode, 409, exists.body);
    assert.deepEqual(exists.json(), { detail: "artifact already exists" });
    const behind = await replace({ "x-expected-version": "1" });
    assert.equal(behind.statusCode, 409, behind.body);
    assert.deepEqual(behind.json(), { detail: "version conflict" });
    const current = await replace({ "x-expected-version": "2" });
    assert.equal(current.statusCode, 201, current.body);
    assert.equal((current.json() as { version: number }).version, 3);
    const notThere = await replace({ "x-expected-version": "4" }, "absent.pdf");
    assert.equal(notThere.statusCode, 409, notThere.body);
    assert.deepEqual(notThere.json(), { detail: "version conflict" });
    const fresh = await replace({ "x-expected-version": "0" }, "fresh.pdf");
    assert.equal(fresh.statusCode, 201, fresh.body);
    assert.equal((fresh.json() as { version: number }).version, 1);
    const malformed = await replace({ "x-expected-version": "two" });
    assert.equal(malformed.statusCode, 422, malformed.body);
    assert.match(malformed.body, /X-Expected-Version must be a whole number/);

    const removed = await app.inject({ method: "DELETE", url: `/api/files/${file.id}`, headers: OWNER });
    assert.equal(removed.statusCode, 204);
    const gone = await app.inject({ method: "GET", url: `/api/files/${file.id}`, headers: OWNER });
    assert.equal(gone.statusCode, 404);
    assert.equal(blobs.objects.size, 2, "only the organisation files' bytes remain");

    const guildPath = file.display_path;
    assert.deepEqual(
      published,
      [
        [guildId, { displayPath: guildPath }],
        [guildId, { displayPath: "org/org_home/files/page.html" }],
        [guildId, { displayPath: guildPath }],
        [guildId, { displayPath: guildPath }],
        [guildId, { displayPath: "org/org_home/files/fresh.pdf" }],
        [guildId, { displayPath: guildPath }],
      ],
      "an upload, a replacement and a deletion are each announced to every guild whose scope the file is in",
    );
  } finally {
    await app.close();
    await database.close();
  }
});
