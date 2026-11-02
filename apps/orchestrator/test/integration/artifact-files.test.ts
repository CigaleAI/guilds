import type pg from "pg";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { addAgent } from "../../src/agents/service.js";
import { systemActor, OPERATOR_ACTOR } from "../helpers/agents.js";
import { ArtifactFiles, fileBlobKey } from "../../src/artifacts/files.js";
import { agentActor, operatorActor } from "../../src/artifacts/actors.js";
import {
  deleteSharedFile,
  uploadSharedFile,
  type SharedFileChange,
  type SharedFileWriteDeps,
} from "../../src/artifacts/operator-files.js";
import { changesAt } from "../helpers/artifacts.js";
import { artifactStore, type ArtifactStore } from "../../src/artifacts/store.js";
import type { Database } from "../../src/db/client.js";
import { connect } from "../../src/seed/connect.js";
import { listConfigChanges } from "../../src/db/config-changes.js";
import { MemoryBlobStore } from "../../src/lib/blob-store.js";
import { NotesStore } from "../../src/notes/store.js";
import { invokeTool } from "../../src/toolbox/index.js";
import { tempDir } from "../helpers/env.js";
import { templatesRoot } from "../helpers/fixtures.js";
import { createIsolatedDatabase, dropIsolatedDatabase, uniqueDbName } from "../helpers/postgres.js";
import { deleteAgent } from "../../src/db/agents.js";
import { deleteGuild, insertGuild } from "../../src/db/guilds.js";
import { agentConfig } from "../helpers/generation.js";
import { accessList, grantAccess } from "../../src/artifacts/access-lists.js";
import { deleteByDisplayPath, listStateArtifacts } from "../../src/artifacts/notes.js";
import { toolArtifacts } from "../../src/toolbox/artifacts.js";
import { toolFixture } from "../helpers/toolbox.js";
import { FIND_MAX } from "../../src/artifacts/types.js";

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

async function seedAgent(agentId: string, guildId: string, name: string) {
  const notes = new NotesStore(tempDir(`guilds-${name}-notes-`), templatesRoot());
  await addAgent(
    { db, notes, artifacts: store },
    { agent: { agentId, guildId, name, config: CONFIG }, task: "", placement: {} },
    systemActor("org_home", { guildId, agentId }),
    new Date(),
  );
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
    await seedAgent("a_alpha", "guild_alpha", "alpha");
    await seedAgent("a_beta", "guild_beta", "beta");
  });

  test("a file is created, replaced version by version, and found by its description", async () => {
    const created = await files.putFile(alpha, {
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
    assert.equal(created.agent_id, null);
    const view = files.view(created);
    assert.equal(view.display_path, "org/org_home/files/figures.csv");
    assert.equal(view.description, "Quarterly figures by region");
    assert.deepEqual(await blobs.get(fileBlobKey("org_home", created.id, 1)), Buffer.from("region,total\nnorth,1\n"));

    const replaced = await files.putFile(alpha, {
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
      () => files.putFile(alpha, { name: "figures.csv", description: "d", mime: "", bytes: Buffer.from("x"), expectedVersion: 1 }),
      /version conflict/,
    );

    const found = await files.findFiles(alpha, { query: "restated", limit: 20 });
    assert.deepEqual(found.map((item) => item.name), ["figures.csv"]);
    assert.equal(found[0]?.access, "write");
    const listed = await files.findFiles(alpha, { limit: 20 });
    assert.deepEqual(listed.map((item) => item.name), ["figures.csv"]);
    assert.deepEqual((await files.findFiles(beta, { limit: 20 })).length, 0);

    const changes = await changesAt(database.pool, "org_home", view.display_path);
    assert.deepEqual(changes.map((change) => [change.operation, change.version]), [["update", 2], ["create", 1]]);
  });

  test("a file follows its access list, and the operator edits that list as for a note", async () => {
    const path_ = "org/org_home/files/figures.csv";
    const row = await files.loadFile(alpha, path_);
    await assert.rejects(() => files.loadFile(beta, path_), /artifact not found/);

    const target = { kind: "file" as const, id: row.id };
    const access = await accessList(store, operator, target);
    assert.deepEqual(access.subjects.map((entry) => [entry.type, entry.id, entry.mode]), [["agent", "a_alpha", "write"]]);
    // a name is one file across the organisation: beta cannot replace a file it does not reach
    await assert.rejects(
      () => files.putFile(beta, { name: "figures.csv", description: "Beta's own figures", mime: "", bytes: Buffer.from("x") }),
      /write not allowed/,
    );
    await grantAccess(store, operator, target, { type: "guild", id: "guild_beta", mode: "read" });
    const read = await files.loadFile(beta, path_);
    assert.equal(read.access, "read");
    await assert.rejects(() => files.deleteFile(beta, read), /write not allowed/);
    await assert.rejects(
      () => files.putFile(beta, { name: "figures.csv", description: "d", mime: "", bytes: Buffer.from("x") }),
      /write not allowed/,
    );
    const logged = await listConfigChanges(database.pool, "org_home", { kind: "file", id: row.id });
    assert.match(String(logged[0]?.summary), /Gave guild beta read on the file org\/org_home\/files\/figures\.csv/);

    // a guild's state holds the files its list names the guild or one of its agents for
    assert.equal((await listStateArtifacts(store, operator, "guild_alpha")).some(
      (item) => item.kind === "file" && item.title === "figures.csv" && item.size === 21,
    ), true);
    assert.equal((await listStateArtifacts(store, operator, "guild_beta")).some((item) => item.title === "figures.csv"), true);
  });

  test("an operator creates a file with the row it names, the organisation at write by default", async () => {
    const upload = { description: "Logo", mime: "", bytes: Buffer.from("png") };
    const logo = await files.putFile(operator, { name: "logo.png", ...upload });
    assert.deepEqual(
      (await accessList(store, operator, { kind: "file", id: logo.id })).subjects.map((entry) => [entry.type, entry.id, entry.mode]),
      [["org", "org_home", "write"]],
    );
    const brief = await files.putFile(operator, {
      name: "beta-brief.txt",
      ...upload,
      startingAccess: [{ type: "guild", id: "guild_beta", mode: "read" }],
    });
    assert.equal((await files.loadFile(beta, files.view(brief).display_path)).access, "read");
    await assert.rejects(() => files.loadFile(alpha, files.view(brief).display_path), /artifact not found/);
    assert.deepEqual((await files.listGuildFiles(operator, "guild_beta")).map((file) => file.name).includes("beta-brief.txt"), true);
    assert.deepEqual((await files.listGuildFiles(operator, "guild_alpha")).map((file) => file.name).includes("beta-brief.txt"), false);
    assert.deepEqual((await files.listAgentFiles(operator, { agentId: "a_beta", guildId: "guild_beta" })).map((file) => file.name).sort(), [
      "beta-brief.txt",
      "figures.csv",
      "logo.png",
    ]);
    assert.deepEqual((await files.listAgentFiles(operator, { agentId: "a_alpha", guildId: "guild_alpha" })).map((file) => file.name).sort(), [
      "figures.csv",
      "logo.png",
    ]);
    assert.deepEqual((await files.listOrgFiles(operator)).map((file) => file.name).sort(), ["beta-brief.txt", "figures.csv", "logo.png"]);
  });

  test("an agent's file is reached by that agent alone, and the note tools point at the file tools", async () => {
    const own = await files.putFile(alpha, { name: "scratch.bin", description: "Scratch bytes", mime: "", bytes: Buffer.from([0, 1, 2]) });
    assert.equal(own.mime, "application/octet-stream");
    assert.equal(files.view(own).display_path, "org/org_home/files/scratch.bin");
    await assert.rejects(() => files.loadFile(beta, files.view(own).display_path), /artifact not found/);

    await assert.rejects(() => deleteByDisplayPath(store, alpha, files.view(own).display_path), /use file_delete for files/);
    const ctx = toolFixture({ run_id: "r_1", agent_id: "a_alpha", guild_id: "guild_alpha", sandbox: null, secrets: {}, artifacts: toolArtifacts(store), artifact_actor: alpha });
    const [got] = await invokeTool(ctx.services, ctx.run, ctx.hooks, { id: "c1", type: "function", function: { name: "note_get", arguments: JSON.stringify({ path: files.view(own).display_path }) } });
    assert.match(String(got.content), /use file_fetch for files/);
  });

  test("the file tools move bytes between the agent's home and the store", async () => {
    const workspace = path.join(tempDir("guilds-files-"), "a_alpha");
    mkdirSync(path.join(workspace, "out"), { recursive: true });
    writeFileSync(path.join(workspace, "out", "report.pdf"), Buffer.from("%PDF-1.4 fake"));
    const ctx = toolFixture({
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
      invokeTool(ctx.services, ctx.run, ctx.hooks, { id: `c_${name}`, type: "function", function: { name, arguments: JSON.stringify(args) } }).then(([message]) => String(message.content));

    const put = await call("file_put", { home_path: "out/report.pdf", description: "The quarterly report" });
    assert.equal(put, "org/org_home/files/report.pdf");
    assert.match(await call("file_put", { home_path: "../escape", description: "d" }), /ERROR: .*under \/home\/a_alpha/);
    const putRow = await files.loadFile(alpha, put);
    assert.deepEqual(
      (await accessList(store, operator, { kind: "file", id: putRow.id })).subjects.map((entry) => [entry.type, entry.id, entry.mode]),
      [["agent", "a_alpha", "write"]],
    );

    const found = JSON.parse(await call("file_find", { query: "quarterly report" })) as { files: Array<{ name: string; mime: string; bytes: number }> };
    assert.deepEqual(found.files.map((item) => [item.name, item.mime, item.bytes]), [["report.pdf", "application/pdf", 13]]);

    const fetched = JSON.parse(await call("file_fetch", { path: put })) as { home_path: string; name: string };
    assert.equal(fetched.home_path, "/home/a_alpha/shared/report.pdf");
    assert.equal(readFileSync(path.join(workspace, "shared", "report.pdf"), "utf8"), "%PDF-1.4 fake");
    const elsewhere = JSON.parse(await call("file_fetch", { path: put, home_path: "in/copy.pdf" })) as { home_path: string };
    assert.equal(elsewhere.home_path, "/home/a_alpha/in/copy.pdf");
    assert.match(await call("file_fetch", { path: "org/org_home/files/missing.pdf" }), /artifact not found/);

    const row = await files.loadFile(alpha, put);
    assert.equal(await call("file_delete", { path: put }), put);
    assert.equal(blobs.objects.has(fileBlobKey("org_home", row.id, row.version)), false);
    await assert.rejects(() => files.loadFile(alpha, put), /artifact not found/);
    assert.equal((await accessList(store, operator, { kind: "file", id: row.id }).catch((error: Error) => error.message)), "file not found");
    const changes = await changesAt(database.pool, "org_home", put);
    assert.deepEqual(changes.map((change) => change.operation), ["delete", "create"]);
  });

  test("an operator's upload and delete are announced to each guild the file's list names", async () => {
    const published: Array<[string, SharedFileChange]> = [];
    const deps: SharedFileWriteDeps = {
      artifacts: store,
      files,
      publishSharedFileChanged: async (guildId, change) => {
        published.push([guildId, change]);
      },
    };
    const upload = { description: "The brief", mime: "", bytes: Buffer.from("brief"), expectedVersion: undefined };
    const guildFile = await uploadSharedFile(deps, operator, {
      name: "brief.txt",
      ...upload,
      access: { type: "guild", id: "guild_beta", mode: "write" },
    });
    const agentFile = await uploadSharedFile(deps, operator, {
      name: "alpha-brief.txt",
      ...upload,
      access: { type: "agent", id: "a_alpha", mode: "read" },
    });
    const orgFile = await uploadSharedFile(deps, operator, { name: "org-brief.txt", ...upload, access: undefined });
    await deleteSharedFile(deps, operator, guildFile.id);
    await deleteSharedFile(deps, operator, orgFile.id);
    const orgPath = { displayPath: "org/org_home/files/org-brief.txt" };
    assert.deepEqual(published, [
      ["guild_beta", { displayPath: "org/org_home/files/brief.txt" }],
      ["guild_alpha", { displayPath: "org/org_home/files/alpha-brief.txt" }],
      // an organisation row puts the file in every guild's scope
      ["guild_alpha", orgPath],
      ["guild_beta", orgPath],
      ["guild_beta", { displayPath: "org/org_home/files/brief.txt" }],
      ["guild_alpha", orgPath],
      ["guild_beta", orgPath],
    ]);
    await assert.rejects(
      () => uploadSharedFile(deps, operator, { name: "bad.txt", ...upload, access: { type: "team", id: "x", mode: "read" } }),
      /access: type must be org, guild, or agent/,
    );

    await deleteSharedFile({ artifacts: store, files }, operator, agentFile.id);
    await assert.rejects(() => files.loadFileById(operator, agentFile.id), /artifact not found/);
    assert.equal(published.length, 7, "a write without a publisher announces nothing");
  });

  test("deleting an agent or a guild drops the rows naming it; a file others reach survives, one only it reached goes", async () => {
    await insertGuild(db, { guildId: "guild_gone", name: "gone", orgId: "org_home", about: "" }, new Date());
    await seedAgent("a_gone", "guild_gone", "gone");
    await seedAgent("a_gone_two", "guild_gone", "gone-two");
    const gone = agentActor({ orgId: "org_home", guildId: "guild_gone", agentId: "a_gone", agentName: "gone" });
    const upload = { description: "Left behind", mime: "", bytes: Buffer.from("left") };
    const agentFile = await files.putFile(gone, { name: "left.txt", ...upload });
    const agentOnly = await files.putFile(gone, { name: "gone-own.txt", ...upload });
    const guildFile = await files.putFile(operator, {
      name: "gone-guild.txt",
      ...upload,
      startingAccess: [{ type: "guild", id: "guild_gone", mode: "write" }],
    });
    const guildOnly = await files.putFile(operator, {
      name: "gone-guild-own.txt",
      ...upload,
      startingAccess: [{ type: "guild", id: "guild_gone", mode: "write" }],
    });
    await grantAccess(store, operator, { kind: "file", id: guildOnly.id }, { type: "agent", id: "a_gone_two", mode: "read" });
    for (const file of [agentFile, guildFile]) {
      await grantAccess(store, operator, { kind: "file", id: file.id }, { type: "guild", id: "guild_alpha", mode: "read" });
    }
    const subjects = async (fileId: string) =>
      (await db.query<{ subject: string }>(
        `SELECT subject_type || ' ' || subject_id AS subject FROM artifact_access
          WHERE target_kind = 'file' AND target_id = $1 ORDER BY subject`,
        [fileId],
      )).rows.map((row) => row.subject);

    const deletion = async (fileId: string) =>
      (await db.query<{ operation: string; actor_id: string }>(
        `SELECT operation, actor_id FROM file_changes WHERE artifact_id = $1 ORDER BY created_at DESC LIMIT 1`,
        [fileId],
      )).rows[0];

    await deleteAgent(db, "a_gone", OPERATOR_ACTOR);
    assert.deepEqual(await subjects(agentFile.id), ["guild guild_alpha"], "the agent's own row goes, the others stay");
    assert.equal((await files.loadFileById(alpha, agentFile.id)).access, "read", "the file survives its creator");
    await assert.rejects(() => files.loadFileById(operator, agentOnly.id), /artifact not found/, "a file only the agent reached goes with it");
    assert.deepEqual(await deletion(agentOnly.id), { operation: "delete", actor_id: "user_operator" });
    await deleteGuild(db, "guild_gone", OPERATOR_ACTOR);
    assert.deepEqual(await subjects(guildFile.id), ["guild guild_alpha"], "the guild's row goes, the others stay");
    assert.equal((await files.loadFileById(alpha, guildFile.id)).access, "read", "the file survives the guild");
    await assert.rejects(() => files.loadFileById(operator, guildOnly.id), /artifact not found/, "a file only the guild and its agents reached goes with it");
    assert.deepEqual(await deletion(guildOnly.id), { operation: "delete", actor_id: "user_operator" });
  });

  test("a find returns at least one file and at most the cap, whatever limit it asks", async () => {
    for (let index = 0; index <= FIND_MAX; index += 1) {
      await files.putFile(alpha, { name: `batch-${index}.txt`, description: "Batch", mime: "", bytes: Buffer.from("b") });
    }
    assert.equal((await files.findFiles(alpha, { limit: -5 })).length, 1);
    assert.equal((await files.findFiles(alpha, { limit: FIND_MAX * 10 })).length, FIND_MAX);
    assert.equal((await files.findFiles(alpha, { query: "batch", limit: -5 })).length, 1);
    assert.equal((await files.findFiles(alpha, { query: "batch", limit: FIND_MAX * 10 })).length, FIND_MAX);
  });
});
