import type pg from "pg";
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { agentActor, operatorActor } from "../../src/artifacts/actors.js";
import { grantAccess } from "../../src/artifacts/access-lists.js";
import { createCollection } from "../../src/artifacts/collections.js";
import { unreachableMarker } from "../../src/artifacts/embeds.js";
import { listRevisions, writeMemory } from "../../src/artifacts/memory.js";
import { deleteByDisplayPath, writeNote } from "../../src/artifacts/notes.js";
import { agentTask, artifactAt, expandTaskText, taskSnapshot } from "../../src/artifacts/service.js";
import { artifactStore, rowDisplayPath, type ArtifactStore } from "../../src/artifacts/store.js";
import { writeAgentTask } from "../../src/artifacts/task.js";
import { EMBED_BUDGET } from "../../src/artifacts/types.js";
import { agentDatabase, persistAgent } from "../../src/agents/persist.js";
import { getAgent, type AgentRow } from "../../src/db/agents.js";
import type { Database } from "../../src/db/client.js";
import { insertGuild } from "../../src/db/guilds.js";
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
  await persistAgent(agentDatabase(db), new NotesStore(tempDir("guilds-svc-notes-"), templatesRoot()), {
    agentId: AGENT,
    guildId: GUILD,
    guildName: "svc",
    orgSlug: "home",
    orgId: ORG,
    name: "svc",
    config: agentConfig({ model: "openrouter/openai/gpt-5.6-luna" }),
    now: new Date(),
    artifacts: store,
  });
  await writeNote(store, operator, { level: "guild", key: "rules.md", content: "Cite sources.\n" });
  const shut = await writeNote(store, operator, { level: "org", key: "shut.md", content: "Not for agents.\n" });
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

    const gone = await writeNote(store, operator, { level: "guild", key: "gone.md", content: "bye\n" });
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
});
