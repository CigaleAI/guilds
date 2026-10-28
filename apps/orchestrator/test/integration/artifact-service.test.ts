import type pg from "pg";
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { agentActor, operatorActor } from "../../src/artifacts/actors.js";
import { grantAccess } from "../../src/artifacts/access-lists.js";
import { createCollection } from "../../src/artifacts/collections.js";
import { unreachableMarker } from "../../src/artifacts/embeds.js";
import { listRevisions, writeMemory } from "../../src/artifacts/memory.js";
import { deleteByDisplayPath } from "../../src/artifacts/notes.js";
import {
  agentTask,
  artifactAt,
  brokenTaskEmbeds,
  embedGraph,
  expandTaskText,
  memoryTimeline,
  taskEmbedRun,
  taskSnapshot,
  writeNote,
} from "../../src/artifacts/service.js";
import { artifactStore, hashArtifactContent, rowDisplayPath, type ArtifactStore } from "../../src/artifacts/store.js";
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
