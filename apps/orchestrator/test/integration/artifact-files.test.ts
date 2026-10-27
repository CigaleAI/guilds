import type pg from "pg";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { agentDatabase, persistAgent } from "../../src/agents/persist.js";
import { ArtifactFiles, fileBlobKey } from "../../src/artifacts/files.js";
import { agentActor, listFileChanges, operatorActor } from "../../src/artifacts/index.js";
import { artifactStore, type ArtifactStore } from "../../src/artifacts/store.js";
import type { Database } from "../../src/db/client.js";
import { connect } from "../../src/seed/connect.js";
import { listConfigChanges } from "../../src/db/config-changes.js";
import { MemoryBlobStore } from "../../src/lib/blob-store.js";
import { NotesStore } from "../../src/notes/store.js";
import { createToolContext, invokeTool } from "../../src/toolbox/index.js";
import { tempDir } from "../helpers/env.js";
import { templatesRoot } from "../helpers/fixtures.js";
import { createIsolatedDatabase, dropIsolatedDatabase, uniqueDbName } from "../helpers/postgres.js";
import { insertGuild } from "../../src/db/guilds.js";
import { agentConfig } from "../helpers/generation.js";
import { accessList, grantAccess } from "../../src/artifacts/access-lists.js";
import { deleteByDisplayPath, listStateArtifacts } from "../../src/artifacts/notes.js";
import { toolArtifacts } from "../../src/toolbox/artifacts.js";

const dbName = uniqueDbName("agent_platform_files");
let database: Database;
let store: ArtifactStore;
let blobs: MemoryBlobStore;
let files: ArtifactFiles;
let db: pg.Pool;

const CONFIG = agentConfig({
  model: "openrouter/openai/gpt-5.6-luna",
  temperature: 1,
  max_tokens: 8192,
  max_steps: 30,
  max_tool_calls: 50,
  max_input_tokens: 100000,
  browser: false,
});

before(async () => {
  database = await connect(await createIsolatedDatabase(dbName));
  db = database.pool;
  store = artifactStore(database.pool, templatesRoot());
  blobs = new MemoryBlobStore();
  files = new ArtifactFiles(store, blobs);
});

after(async () => {
  await database.close();
  await dropIsolatedDatabase(dbName);
});

async function seedAgent(agentId: string, guildId: string, guildName: string, name: string) {
  const notes = new NotesStore(tempDir(`guilds-${name}-notes-`), templatesRoot());
  await persistAgent(agentDatabase(db), notes, {
    agentId,
    guildId,
    guildName,
    orgSlug: "home",
    orgId: "org_home",
    name,
    config: CONFIG,
    now: new Date(),
    artifacts: store,
  });
}

const operator = operatorActor({ orgId: "org_home", actorId: "user_operator", actorName: "operator" });
const alpha = agentActor({ orgId: "org_home", guildId: "guild_alpha", agentId: "a_alpha", agentName: "alpha" });
const beta = agentActor({ orgId: "org_home", guildId: "guild_beta", agentId: "a_beta", agentName: "beta" });

describe("shared files", { concurrency: 1 }, () => {
  before(async () => {
    const now = new Date();
    await insertGuild(db,
      { guildId: "guild_alpha", name: "alpha", orgId: "org_home", about: "" },
      now,
    );
    await insertGuild(db,
      { guildId: "guild_beta", name: "beta", orgId: "org_home", about: "" },
      now,
    );
    await seedAgent("a_alpha", "guild_alpha", "alpha", "alpha");
    await seedAgent("a_beta", "guild_beta", "beta", "beta");
  });

  test("a file is created, replaced version by version, and found by its description", async () => {
    const created = await files.putFile(alpha, {
      level: "guild",
      name: "figures.csv",
      description: "Quarterly figures by region",
      mime: "",
      bytes: Buffer.from("region,total\nnorth,1\n"),
    });
    assert.equal(created.kind, "file");
    assert.equal(created.mime, "text/csv");
    assert.equal(created.bytes, 21);
    assert.equal(created.version, 1);
    assert.equal(created.access, "write");
    const view = files.view(created);
    assert.equal(view.display_path, "org/org_home/guilds/guild_alpha/files/figures.csv");
    assert.equal(view.description, "Quarterly figures by region");
    assert.deepEqual(await blobs.get(fileBlobKey("org_home", created.id, 1)), Buffer.from("region,total\nnorth,1\n"));

    const replaced = await files.putFile(alpha, {
      level: "guild",
      name: "figures.csv",
      description: "Quarterly figures by region, restated",
      mime: "text/csv",
      bytes: Buffer.from("region,total\nnorth,2\n"),
    });
    assert.equal(replaced.id, created.id);
    assert.equal(replaced.version, 2);
    assert.equal(await files.readBytes(replaced).then(String), "region,total\nnorth,2\n");
    assert.equal(blobs.objects.has(fileBlobKey("org_home", created.id, 1)), false, "the replaced version's bytes are gone");

    await assert.rejects(
      () => files.putFile(alpha, { level: "guild", name: "figures.csv", description: "d", mime: "", bytes: Buffer.from("x"), expectedVersion: 1 }),
      /version conflict/,
    );

    const found = await files.findFiles(alpha, { query: "restated", limit: 20 });
    assert.deepEqual(found.map((item) => item.name), ["figures.csv"]);
    assert.equal(found[0]?.access, "write");
    const listed = await files.findFiles(alpha, { level: "guild", limit: 20 });
    assert.deepEqual(listed.map((item) => item.name), ["figures.csv"]);
    assert.deepEqual((await files.findFiles(alpha, { level: "org", limit: 20 })).length, 0);

    const changes = await listFileChanges(database.pool, "org_home", view.display_path);
    assert.deepEqual(changes.map((change) => [change.operation, change.version]), [["update", 2], ["create", 1]]);
  });

  test("a file follows its access list, and the operator edits that list as for a note", async () => {
    const row = await files.loadFile(alpha, "org/org_home/guilds/guild_alpha/files/figures.csv");
    await assert.rejects(() => files.loadFile(beta, "org/org_home/guilds/guild_alpha/files/figures.csv"), /artifact not found/);

    const target = { kind: "file" as const, id: row.id };
    const access = await accessList(store, operator, target);
    assert.deepEqual(access.subjects.map((entry) => [entry.type, entry.id, entry.mode]), [["guild", "guild_alpha", "write"]]);
    await grantAccess(store, operator, target, { type: "guild", id: "guild_beta", mode: "read" });
    const read = await files.loadFile(beta, "org/org_home/guilds/guild_alpha/files/figures.csv");
    assert.equal(read.access, "read");
    await assert.rejects(() => files.deleteFile(beta, read), /write not allowed/);
    // `guild` always means the writer's own guild, so beta's put makes a new file in guild_beta.
    const betas = await files.putFile(beta, { level: "guild", name: "figures.csv", description: "Beta's own figures", mime: "", bytes: Buffer.from("x") });
    assert.equal(files.view(betas).display_path, "org/org_home/guilds/guild_beta/files/figures.csv");
    await assert.rejects(() => files.putFile(beta, { level: "org", name: "figures.csv", description: "d", mime: "", bytes: Buffer.from("x") }), /write not allowed/);
    const logged = await listConfigChanges(database.pool, "org_home", { kind: "file", id: row.id });
    assert.match(String(logged[0]?.summary), /Gave guild beta read on the file org\/org_home\/guilds\/guild_alpha\/files\/figures\.csv/);

    assert.equal((await listStateArtifacts(store, operator, { guildId: "guild_alpha", agentIds: ["a_alpha"] })).some(
      (item) => item.kind === "file" && item.title === "figures.csv" && item.size === 21,
    ), true);
  });

  test("an agent creates files at agent and guild level only, and the note tools point at the file tools", async () => {
    await assert.rejects(
      () => files.putFile(alpha, { level: "org", name: "logo.png", description: "d", mime: "", bytes: Buffer.from("x") }),
      /write not allowed/,
    );
    const own = await files.putFile(alpha, { level: "agent", name: "scratch.bin", description: "Scratch bytes", mime: "", bytes: Buffer.from([0, 1, 2]) });
    assert.equal(own.mime, "application/octet-stream");
    assert.equal(files.view(own).display_path, "org/org_home/agents/a_alpha/files/scratch.bin");
    await assert.rejects(() => files.loadFile(beta, files.view(own).display_path), /artifact not found/);

    await assert.rejects(() => deleteByDisplayPath(store, alpha, files.view(own).display_path), /use file_delete for files/);
    const ctx = createToolContext({ run_id: "r_1", agent_id: "a_alpha", guild_id: "guild_alpha", sandbox: null, secrets: {}, artifacts: toolArtifacts(store), artifact_actor: alpha });
    const [got] = await invokeTool(ctx, { id: "c1", function: { name: "note_get", arguments: { path: files.view(own).display_path } } }, {}, 32_768);
    assert.match(String(got.content), /use file_fetch for files/);
  });

  test("the file tools move bytes between the agent's home and the store", async () => {
    const workspace = path.join(tempDir("guilds-files-"), "a_alpha");
    mkdirSync(path.join(workspace, "out"), { recursive: true });
    writeFileSync(path.join(workspace, "out", "report.pdf"), Buffer.from("%PDF-1.4 fake"));
    const ctx = createToolContext({
      run_id: "r_2",
      agent_id: "a_alpha",
      guild_id: "guild_alpha",
      sandbox: null,
      secrets: {},
      artifacts: toolArtifacts(store),
      artifact_actor: alpha,
      files,
      workspace_dir: workspace,
    });
    const call = (name: string, args: Record<string, unknown>) =>
      invokeTool(ctx, { id: `c_${name}`, function: { name, arguments: args } }, {}, 32_768).then(([message]) => String(message.content));

    const put = await call("file_put", { home_path: "out/report.pdf", level: "guild", description: "The quarterly report" });
    assert.equal(put, "org/org_home/guilds/guild_alpha/files/report.pdf");
    assert.match(await call("file_put", { home_path: "../escape", level: "guild", description: "d" }), /ERROR: .*under \/home\/a_alpha/);
    assert.match(await call("file_put", { home_path: "out/report.pdf", level: "nowhere", description: "d" }), /level must be agent, guild, or org/);

    const found = JSON.parse(await call("file_find", { query: "quarterly report" })) as { files: Array<{ name: string; mime: string; bytes: number }> };
    assert.deepEqual(found.files.map((item) => [item.name, item.mime, item.bytes]), [["report.pdf", "application/pdf", 13]]);

    const fetched = JSON.parse(await call("file_fetch", { path: put })) as { home_path: string; name: string };
    assert.equal(fetched.home_path, "/home/a_alpha/shared/report.pdf");
    assert.equal(readFileSync(path.join(workspace, "shared", "report.pdf"), "utf8"), "%PDF-1.4 fake");
    const elsewhere = JSON.parse(await call("file_fetch", { path: put, home_path: "in/copy.pdf" })) as { home_path: string };
    assert.equal(elsewhere.home_path, "/home/a_alpha/in/copy.pdf");
    assert.match(await call("file_fetch", { path: "org/org_home/guilds/guild_alpha/files/missing.pdf" }), /artifact not found/);

    const row = await files.loadFile(alpha, put);
    assert.equal(await call("file_delete", { path: put }), put);
    assert.equal(blobs.objects.has(fileBlobKey("org_home", row.id, row.version)), false);
    await assert.rejects(() => files.loadFile(alpha, put), /artifact not found/);
    assert.equal((await accessList(store, operator, { kind: "file", id: row.id }).catch((error: Error) => error.message)), "file not found");
    const changes = await listFileChanges(database.pool, "org_home", put);
    assert.deepEqual(changes.map((change) => change.operation), ["delete", "create"]);
  });
});
