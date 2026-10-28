import type pg from "pg";
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { agentActor, operatorActor } from "../../src/artifacts/actors.js";
import { grantAccess, listAccess, raiseAccess } from "../../src/artifacts/access-lists.js";
import { createCollection, getCollection } from "../../src/artifacts/collections.js";
import { embedGraph, unreachableMarker } from "../../src/artifacts/embeds.js";
import { listRevisions, memoryTimeline, writeMemory } from "../../src/artifacts/memory.js";
import {
  artifactAt,
  deleteByDisplayPath,
  notesNamed,
  readStateNotes,
  writeNote,
  writeNoteAt,
} from "../../src/artifacts/notes.js";
import { addRecord, listRecordsWithHint } from "../../src/artifacts/records.js";
import {
  applyCollectionStep,
  guildTable,
  guildTables,
  listGuildCollections,
} from "../../src/artifacts/guild-tables.js";
import { artifactStore, hashArtifactContent, rowDisplayPath, type ArtifactStore } from "../../src/artifacts/store.js";
import {
  agentTask,
  brokenTaskEmbeds,
  expandTaskText,
  publishAgentTask,
  taskEmbedRun,
  taskSnapshot,
  writeAgentTask,
} from "../../src/artifacts/task.js";
import { EMBED_BUDGET } from "../../src/artifacts/types.js";
import { addAgent } from "../../src/agents/service.js";
import { systemActor } from "../helpers/agents.js";
import { getAgent, listAgentTaskRevisions, type AgentRow } from "../../src/db/agents.js";
import type { Database } from "../../src/db/client.js";
import { insertGuild } from "../../src/db/guilds.js";
import { withTransaction } from "../../src/db/pg.js";
import { NotesStore } from "../../src/notes/store.js";
import { connect } from "../../src/seed/connect.js";
import { tempDir } from "../helpers/env.js";
import { templatesRoot } from "../helpers/fixtures.js";
import { agentConfig } from "../helpers/generation.js";
import { createIsolatedDatabase, dropIsolatedDatabase, uniqueDbName } from "../helpers/postgres.js";

const dbName = uniqueDbName("agent_platform_artifact_service");
let database: Database;
let store: ArtifactStore;
let db: pg.Pool;

const ORG = "org_home";
const GUILD = "guild_svc";
const OTHER_GUILD = "guild_other";
const AGENT = "a_svc";
const operator = operatorActor({ orgId: ORG, actorId: "user_operator", actorName: "operator", guildId: GUILD });
const agent = agentActor({ orgId: ORG, guildId: GUILD, agentId: AGENT, agentName: "svc" });
const rulesPath = `org/${ORG}/guilds/${GUILD}/rules.md`;
const shutPath = `org/${ORG}/shut.md`;

before(async () => {
  database = await connect(await createIsolatedDatabase(dbName));
  db = database.pool;
  store = artifactStore(db, templatesRoot());
  await insertGuild(db, { guildId: GUILD, name: "svc", orgId: ORG, about: "" }, new Date());
  await insertGuild(db, { guildId: OTHER_GUILD, name: "other", orgId: ORG, about: "" }, new Date());
  await addAgent(
    { db, notes: new NotesStore(tempDir("guilds-svc-notes-"), templatesRoot()), artifacts: store },
    { agent: { agentId: AGENT, guildId: GUILD, name: "svc", config: agentConfig({ model: "openrouter/openai/gpt-5.6-luna" }) }, task: "", placement: {} },
    systemActor(ORG, { guildId: GUILD, agentId: AGENT }),
    new Date(),
  );
  await writeNote(store, operator, { level: "guild", key: "rules.md", content: "Cite sources.\n" });
  const { row: shut } = await writeNote(store, operator, { level: "org", key: "shut.md", content: "Not for agents.\n" });
  await grantAccess(store, operator, { kind: "note", id: shut.id }, { type: "agent", id: AGENT, mode: "none" });
});

after(async () => {
  await database.close();
  await dropIsolatedDatabase(dbName);
});

async function agentWithTask(task: string): Promise<AgentRow> {
  await writeAgentTask(db, operator, AGENT, task);
  const row = await getAgent(db, AGENT);
  assert.ok(row);
  return row;
}

describe("artifact service", { concurrency: 1 }, () => {
  test("agentTask inlines the Task as the agent reads it and carries its stored Memory", async () => {
    await writeMemory(store, operator, AGENT, { content: "- keep it short\n", detail: "test" });
    const row = await agentWithTask(`Follow ![[${rulesPath}]] and ![[${shutPath}]]\n`);
    const task = await agentTask(store, row);
    assert.equal(task.text, row.task);
    assert.equal(task.version, row.task_version);
    assert.equal(task.hash, row.task_hash);
    assert.equal(task.displayPath, `org/${ORG}/agents/${AGENT}/task.md`);
    assert.equal(task.hasEmbeds, true);
    assert.deepEqual(task.expanded, {
      ok: true,
      text: `Follow <rules path="${rulesPath}" level="guild">\nCite sources.\n</rules> and ${unreachableMarker(shutPath)}\n`,
    });
    assert.equal(task.memory?.content_text, "- keep it short\n");
    assert.equal(task.memoryText, "- keep it short\n");
  });

  test("agentTask reports a Task whose embeds pass the embed budget as not inlined", async () => {
    await writeNote(store, operator, { level: "guild", key: "large.md", content: "x".repeat(EMBED_BUDGET + 1) });
    const row = await agentWithTask(`Read ![[org/${ORG}/guilds/${GUILD}/large.md]]\n`);
    const task = await agentTask(store, row);
    assert.deepEqual(task.expanded, { ok: false, error: "embed budget exceeded" });
    assert.equal(task.text, row.task);
  });

  test("agentTask reads a Task without embeds as it is written", async () => {
    const row = await agentWithTask("Summarise the inbox.\n");
    const task = await agentTask(store, row);
    assert.equal(task.hasEmbeds, false);
    assert.deepEqual(task.expanded, { ok: true, text: "Summarise the inbox.\n" });
  });

  test("expandTaskText inlines a proposed text as the agent reads it and refuses one past the embed budget", async () => {
    const row = await agentWithTask("Summarise the inbox.\n");
    assert.equal(
      await expandTaskText(store, row, `Use ![[${shutPath}]]\n`),
      `Use ${unreachableMarker(shutPath)}\n`,
    );
    await assert.rejects(expandTaskText(store, row, `Read ![[org/${ORG}/guilds/${GUILD}/large.md]]\n`), {
      name: "ArtifactError",
      message: "embed budget exceeded",
    });
  });

  test("publishAgentTask writes a draft built on the live version and keeps the text it replaces", async () => {
    const row = await agentWithTask("Summarise the inbox.\n");
    const result = await withTransaction(db, (tx) =>
      publishAgentTask(tx, operator, AGENT, { content: "Summarise the inbox daily.\n", baseVersion: row.task_version }),
    );
    assert.ok(result.outcome === "published");
    assert.equal(result.task.version, row.task_version + 1);
    assert.equal(result.task.content_text, "Summarise the inbox daily.\n");
    const revisions = await listAgentTaskRevisions(db, ORG, AGENT);
    assert.equal(revisions[0]?.content, "Summarise the inbox.\n");
  });

  test("publishAgentTask writes nothing when the Task moved on from the draft's version", async () => {
    const row = await agentWithTask("Summarise the inbox.\n");
    const result = await withTransaction(db, (tx) =>
      publishAgentTask(tx, operator, AGENT, { content: "Something else.\n", baseVersion: row.task_version - 1 }),
    );
    assert.deepEqual(result, { outcome: "conflict" });
    assert.equal((await getAgent(db, AGENT))?.task, "Summarise the inbox.\n");
  });

  test("publishAgentTask writes nothing when the draft's text is the Task's", async () => {
    const row = await agentWithTask("Summarise the inbox.\n");
    const result = await withTransaction(db, (tx) =>
      publishAgentTask(tx, operator, AGENT, { content: "Summarise the inbox.\n", baseVersion: row.task_version }),
    );
    assert.deepEqual(result, { outcome: "unchanged" });
    assert.equal((await getAgent(db, AGENT))?.task_version, row.task_version);
  });

  test("publishAgentTask answers missing for an agent without a Task", async () => {
    const result = await withTransaction(db, (tx) =>
      publishAgentTask(tx, operator, "a_absent", { content: "Hello.\n", baseVersion: 1 }),
    );
    assert.deepEqual(result, { outcome: "missing" });
  });

  test("taskSnapshot keeps the notes and collections the agent reads, with the Task's version, hash and path", async () => {
    const papers = await createCollection(store, operator, { name: "papers", purpose: "reading list" });
    await grantAccess(store, operator, { kind: "collection", id: papers.id }, { type: "agent", id: AGENT, mode: "read" });
    const row = await agentWithTask(`Follow ![[${rulesPath}]], ![[${shutPath}]] and ![[${papers.display_path}]]\n`);
    const snapshot = await taskSnapshot(store, row);
    assert.equal(snapshot.version, row.task_version);
    assert.equal(snapshot.hash, row.task_hash);
    assert.equal(snapshot.display_path, `org/${ORG}/agents/${AGENT}/task.md`);
    assert.equal(snapshot.has_embeds, true);
    assert.deepEqual(snapshot.embeds.map((item) => item.display_path), [rulesPath]);
    assert.deepEqual(snapshot.collections, [papers.display_path]);
  });

  test("artifactAt reads a live row, a deleted one, and an archived Memory revision", async () => {
    const live = await artifactAt(store, operator, rulesPath);
    assert.equal(live.kind, "row");
    assert.equal(live.kind === "row" && live.deleted, false);
    assert.equal(live.kind === "row" ? live.row.content_text : null, "Cite sources.\n");

    const { row: gone } = await writeNote(store, operator, { level: "guild", key: "gone.md", content: "bye\n" });
    await deleteByDisplayPath(store, operator, rowDisplayPath(gone));
    const deleted = await artifactAt(store, operator, rowDisplayPath(gone));
    assert.equal(deleted.kind === "row" && deleted.deleted, true);

    await writeMemory(store, operator, AGENT, { content: "- replaced\n", detail: "test" });
    const [revision] = await listRevisions(store, operator, AGENT);
    assert.ok(revision);
    const archived = await artifactAt(store, operator, revision.display_path);
    assert.deepEqual(archived, { kind: "revision", content: revision.content, displayPath: revision.display_path });
  });

  test("artifactAt refuses a malformed path, a path outside the organisation, an absent artifact, and the archive to an agent", async () => {
    await assert.rejects(artifactAt(store, operator, "notes/rules.md"), { name: "ArtifactError", message: "unknown artifact path" });
    await assert.rejects(artifactAt(store, operator, "org/org_other/rules.md"), {
      name: "ArtifactError",
      message: "artifact is not in this organisation",
    });
    await assert.rejects(artifactAt(store, operator, `org/${ORG}/missing.md`), { name: "ArtifactError", message: "artifact not found" });
    const [revision] = await listRevisions(store, operator, AGENT);
    assert.ok(revision);
    await assert.rejects(artifactAt(store, agent, revision.display_path), { name: "ArtifactError", message: "unknown artifact path" });
    await assert.rejects(artifactAt(store, agent, shutPath), { name: "ArtifactError", message: "artifact not found" });
  });

  test("artifactAt gives a row's display path and its text, a record's as its JSON view", async () => {
    const note = await artifactAt(store, operator, rulesPath);
    assert.ok(note.kind === "row");
    assert.equal(note.href, rulesPath);
    assert.equal(note.text, "Cite sources.\n");

    await createCollection(store, operator, { name: "viewed", purpose: "Viewed", columns: [{ name: "title", type: "text", description: "title" }] });
    const { record } = await addRecord(store, operator, { collection: "viewed", body: { title: "First" } });
    const href = `org/${ORG}/collections/viewed/${String(record.id)}`;
    const view = await artifactAt(store, operator, href);
    assert.ok(view.kind === "row");
    assert.equal(view.href, href);
    assert.deepEqual(Object.keys(JSON.parse(view.text)).slice(0, 4), ["id", "collection", "display_path", "title"]);
    assert.equal(JSON.parse(view.text).title, "First");
    assert.match(view.text, /^\{\n {2}"id"/);
  });

  test("writeNoteAt rewrites a live note and says where it sits, and refuses a path that holds no note", async () => {
    const written = await writeNoteAt(store, operator, rulesPath, "Cite sources twice.\n");
    assert.equal(written.href, rulesPath);
    assert.equal(written.row.content_text, "Cite sources twice.\n");
    await assert.rejects(writeNoteAt(store, operator, `org/${ORG}/collections/viewed`, "x"), { name: "ArtifactError", message: "artifact not found" });
    await assert.rejects(writeNoteAt(store, operator, `org/${ORG}/absent.md`, "x"), { name: "ArtifactError", message: "artifact not found" });
    await writeNoteAt(store, operator, rulesPath, "Cite sources.\n");
  });

  test("writeMemory says where the Memory sits", async () => {
    const written = await writeMemory(store, operator, AGENT, { content: "- noted\n", detail: "test" });
    assert.equal(written.href, `org/${ORG}/agents/${AGENT}/memory.md`);
    assert.equal(written.row.content_text, "- noted\n");
  });

  test("notesNamed finds the notes named by display path or file name, each with its access list", async () => {
    const found = await notesNamed(store, operator, new Set([rulesPath, "shut.md", "absent.md"]));
    assert.deepEqual(
      found.map((note) => [note.href, note.access.map((entry) => [entry.type, entry.id, entry.mode])]),
      [
        [rulesPath, [["guild", GUILD, "write"]]],
        [shutPath, [["org", ORG, "read"], ["agent", AGENT, "none"]]],
      ],
    );
    assert.deepEqual(await notesNamed(store, operator, new Set()), []);
  });

  test("readStateNotes reads the guild's agents' notes, then its own, then the organisation's, with their text", async () => {
    const { href: ownPath } = await writeNote(store, agent, { level: "agent", key: "own.md", content: "Mine.\n" });
    const notes = await readStateNotes(store, operator, { guildId: GUILD, agentIds: [AGENT] });
    const hrefs = notes.map((note) => note.href);
    assert.ok(hrefs.indexOf(ownPath) < hrefs.indexOf(rulesPath));
    assert.ok(hrefs.indexOf(rulesPath) < hrefs.indexOf(shutPath));
    assert.equal(notes.find((note) => note.href === ownPath)?.row.content_text, "Mine.\n");
    assert.equal(notes.find((note) => note.href === rulesPath)?.row.content_text, "Cite sources.\n");
  });

  test("readStateNotes leaves out a note the reader cannot read", async () => {
    const hrefs = (await readStateNotes(store, agent, { guildId: GUILD, agentIds: [AGENT] })).map((note) => note.href);
    assert.ok(hrefs.includes(rulesPath));
    assert.ok(!hrefs.includes(shutPath));
  });

  test("guildTables lists the guild's own tables and the organisation's with counts and access lists, not another guild's own", async () => {
    await createCollection(store, operator, { name: "own-desk", purpose: "Own", guildId: GUILD });
    await createCollection(store, operator, { name: "other-desk", purpose: "Other", guildId: OTHER_GUILD });
    const tables = await guildTables(store, operator, GUILD);
    const names = tables.map((table) => table.collection.name);
    assert.ok(names.includes("own-desk"));
    assert.ok(names.includes("viewed"));
    assert.ok(!names.includes("other-desk"));
    const viewed = tables.find((table) => table.collection.name === "viewed");
    assert.equal(viewed?.collection.count, 1);
    assert.deepEqual(viewed?.access.map((entry) => [entry.type, entry.mode]), [["org", "read"]]);
    const own = tables.find((table) => table.collection.name === "own-desk");
    assert.deepEqual(own?.access.map((entry) => [entry.type, entry.id, entry.mode]), [["guild", GUILD, "write"]]);
  });

  test("listGuildCollections lists the guild's own collections and the organisation's, not another guild's own", async () => {
    const names = (await listGuildCollections(store, operator, GUILD)).map((collection) => collection.name);
    assert.ok(names.includes("own-desk"));
    assert.ok(names.includes("viewed"));
    assert.ok(!names.includes("other-desk"));
    const otherNames = (await listGuildCollections(store, operator, OTHER_GUILD)).map((collection) => collection.name);
    assert.ok(otherNames.includes("other-desk"));
    assert.ok(!otherNames.includes("own-desk"));
  });

  test("guildTable finds one of the guild's tables by name or id, and nothing for another guild's own or an unknown one", async () => {
    const byName = await guildTable(store, operator, GUILD, { name: "own-desk" });
    assert.equal(byName?.collection.name, "own-desk");
    assert.deepEqual(byName?.access.map((entry) => entry.type), ["guild"]);
    const byId = await guildTable(store, operator, GUILD, { id: String(byName?.collection.id) });
    assert.equal(byId?.collection.id, byName?.collection.id);
    assert.equal(await guildTable(store, operator, GUILD, { name: "other-desk" }), null);
    assert.equal(await guildTable(store, operator, GUILD, { name: "Not A Name" }), null);
    assert.equal(await guildTable(store, operator, GUILD, { id: "acol_missing" }), null);
  });

  test("raiseAccess writes only the rows that raise the guild and its writers, and never lowers a row", async () => {
    const table = await createCollection(store, operator, { name: "raised", purpose: "Raised" });
    const target = { kind: "collection" as const, id: table.id };
    await raiseAccess(store, operator, target, { guildId: GUILD, mode: "read", writerIds: [AGENT] });
    const rows = async () => (await listAccess(store, operator, target)).map((entry) => [entry.type, entry.id, entry.mode]);
    assert.deepEqual(await rows(), [["org", ORG, "read"], ["agent", AGENT, "write"]]);
    await raiseAccess(store, operator, target, { guildId: GUILD, mode: "write", writerIds: [AGENT] });
    assert.deepEqual(await rows(), [["org", ORG, "read"], ["guild", GUILD, "write"], ["agent", AGENT, "write"]]);
    await raiseAccess(store, operator, target, { guildId: GUILD, mode: "read", writerIds: [] });
    assert.deepEqual(await rows(), [["org", ORG, "read"], ["guild", GUILD, "write"], ["agent", AGENT, "write"]]);
  });

  test("applyCollectionStep creates a table with its access rows, edits its definition and rows, and deletes it", async () => {
    await applyCollectionStep(store, operator, {
      action: "create",
      collection: { name: "stepped", purpose: "Stepped", columns: [], guildId: GUILD },
      access: [{ type: "agent", id: AGENT, mode: "read" }],
    });
    const created = await guildTable(store, operator, GUILD, { name: "stepped" });
    assert.ok(created);
    assert.deepEqual(created.access.map((entry) => [entry.type, entry.mode]), [["guild", "write"], ["agent", "read"]]);

    await applyCollectionStep(store, operator, {
      action: "edit",
      id: created.collection.id,
      changes: { purpose: "Stepped twice" },
      access: [{ type: "agent", id: AGENT, mode: null }],
    });
    const edited = await getCollection(store, operator, created.collection.id);
    assert.equal(edited.purpose, "Stepped twice");
    assert.deepEqual((await listAccess(store, operator, { kind: "collection", id: created.collection.id })).map((entry) => entry.type), ["guild"]);

    await applyCollectionStep(store, operator, { action: "edit", id: created.collection.id, changes: null, access: [] });
    assert.equal((await getCollection(store, operator, created.collection.id)).purpose, "Stepped twice");

    await applyCollectionStep(store, operator, { action: "delete", id: created.collection.id });
    assert.equal(await guildTable(store, operator, GUILD, { id: created.collection.id }), null);
  });

  test("listRecordsWithHint explains an empty narrowed listing, and only that one", async () => {
    const narrowed = await listRecordsWithHint(store, operator, { collection: "viewed", where: { title: "Absent" } });
    assert.deepEqual(narrowed.records, []);
    assert.match(String(narrowed.hint), /^No records in viewed where \{"title":"Absent"\}\. viewed holds 1 record;/);
    const plain = await listRecordsWithHint(store, operator, { collection: "viewed" });
    assert.equal(plain.total, 1);
    assert.equal(plain.hint, null);
    const found = await listRecordsWithHint(store, operator, { collection: "viewed", where: { title: "First" } });
    assert.equal(found.records.length, 1);
    assert.equal(found.hint, null);
  });

  test("writeNote writes under the owner the level names for the actor and says where the note sits", async () => {
    const written = await writeNote(store, agent, { level: "agent", key: " own.md ", content: "mine\n" });
    assert.equal(written.href, `org/${ORG}/agents/${AGENT}/own.md`);
    assert.equal(written.row.key, "own.md");
    assert.equal(written.row.owner_id, AGENT);
  });

  test("taskEmbedRun walks the Task as the agent reads it and names the inlined embeds the agent cannot read", async () => {
    const row = await agentWithTask(`Follow ![[${rulesPath}]] and ![[${shutPath}]]\n`);
    const run = await taskEmbedRun(store, row);
    assert.deepEqual(run.steps, [
      { from: null, href: rulesPath, depth: 1, inlined: true },
      { from: null, href: shutPath, depth: 1, inlined: true },
    ]);
    assert.deepEqual([...run.unreachable], [shutPath]);
  });

  test("brokenTaskEmbeds lists the embeds of the Task the agent cannot read", async () => {
    const row = await agentWithTask(`Follow ![[${rulesPath}]], ![[${shutPath}]] and ![[org/${ORG}/missing.md]]\n`);
    assert.deepEqual(await brokenTaskEmbeds(store, row), [shutPath, `org/${ORG}/missing.md`]);
  });

  test("embedGraph reaches what the texts embed as the reader reads them, past what it holds, with the depth and budget a run inlines", async () => {
    const graph = await embedGraph(
      store,
      operator,
      [`![[${rulesPath}]] ![[${shutPath}]] ![[org/${ORG}/missing.md]]`],
      new Set([rulesPath]),
    );
    assert.deepEqual(
      graph.targets.map((target) => [target.href, target.kind === "note" ? target.text : null]),
      [[shutPath, "Not for agents.\n"]],
    );
    assert.deepEqual(graph.unresolved, [{ href: `org/${ORG}/missing.md`, reason: "not reachable" }]);
    assert.equal(graph.depth, 2);
    assert.equal(graph.budget, EMBED_BUDGET);
  });

  test("memoryTimeline lists the Memory's versions newest first with its path and live hash, the archive only to an operator", async () => {
    await writeMemory(store, operator, AGENT, { content: "- newest\n", detail: "test" });
    const revisions = await listRevisions(store, operator, AGENT);
    const timeline = await memoryTimeline(store, operator, AGENT);
    assert.equal(timeline.displayPath, `org/${ORG}/agents/${AGENT}/memory.md`);
    const live = await artifactAt(store, operator, timeline.displayPath);
    assert.ok(live.kind === "row");
    assert.equal(timeline.live?.version, live.row.version);
    assert.equal(timeline.live?.contentHash, hashArtifactContent("- newest\n"));
    assert.equal(timeline.entries.length, revisions.length + 1);
    assert.equal(timeline.entries[0]?.revision_id, null);
    assert.equal(timeline.entries[0]?.content, "- newest\n");
    const asAgent = await memoryTimeline(store, agent, AGENT);
    assert.deepEqual(
      asAgent.entries.map((entry) => entry.content),
      ["- newest\n"],
    );
  });
});
