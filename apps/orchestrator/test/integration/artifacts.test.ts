import type pg from "pg";
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { writeAgentTask } from "../../src/artifacts/task.js";
import { artifactStore, type ArtifactStore, artifactView, rowDisplayPath } from "../../src/artifacts/store.js";
import { agentActor, operatorActor } from "../../src/artifacts/actors.js";
import { listFileChanges } from "../../src/db/file-changes.js";
import { unreachableMarker, embedSource, inlineTaskEmbeds, inspectTaskEmbeds } from "../../src/artifacts/embeds.js";
import { revisionDisplayPath } from "../../src/artifacts/paths.js";
import { addAgent } from "../../src/agents/service.js";
import { systemActor } from "../helpers/agents.js";
import type { Database } from "../../src/db/client.js";
import { connect } from "../../src/seed/connect.js";
import { NotesStore } from "../../src/notes/store.js";
import { createToolContext, invokeTool } from "../../src/toolbox/index.js";
import { templatesRoot } from "../helpers/fixtures.js";
import { tempDir } from "../helpers/env.js";
import { compareColumnTimestamps } from "../../src/db/codecs.js";
import { listConfigChanges } from "../../src/db/config-changes.js";
import { createIsolatedDatabase, dropIsolatedDatabase, uniqueDbName } from "../helpers/postgres.js";
import { deleteGuild, insertGuild } from "../../src/db/guilds.js";
import { insertOrg } from "../../src/db/orgs.js";
import { getAgentTask, listAgentTaskRevisions } from "../../src/db/agents.js";
import { insertRun } from "../../src/db/runs.js";
import { agentConfig, runSnapshot } from "../helpers/generation.js";
import {
  canReadDisplayPath,
  deleteByDisplayPath,
  findNotes,
  getByDisplayPath,
  listEmbeddableNotes,
  listOwnerNotes,
  writeNote,
  writeNoteAt,
} from "../../src/artifacts/notes.js";
import {
  buildMemoryTimeline,
  getMemoryRow,
  listRevisions,
  writeMemory,
} from "../../src/artifacts/memory.js";
import { accessList, grantAccess, listAccess, reachOf, replaceAccess } from "../../src/artifacts/access-lists.js";
import { clearRecords, collectionCatalog, collectionFacts, createCollection, deleteCollection, describeCollection, getCollection, listCollectionsWithCounts, updateCollection } from "../../src/artifacts/collections.js";
import { addRecord, exportRecords, getRecord, listRecords, removeRecord, searchRecords, updateRecord } from "../../src/artifacts/records.js";
import { toolArtifacts } from "../../src/toolbox/artifacts.js";

const dbName = uniqueDbName("agent_platform_artifacts");
let database: Database;
let store: ArtifactStore;
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
  const databaseUrl = await createIsolatedDatabase(dbName);
  database = await connect(databaseUrl);
  db = database.pool;
  store = artifactStore(database.pool, templatesRoot());
});

after(async () => {
  await database.close();
  await dropIsolatedDatabase(dbName);
});

async function seedAgent(agentId: string, guildId: string, name: string, tag: string) {
  const now = new Date();
  const notes = new NotesStore(tempDir(`guilds-${tag}-notes-`), templatesRoot());
  await addAgent(
    { db, notes, artifacts: store },
    { agent: { agentId, guildId, name, config: CONFIG }, task: "", placement: {} },
    systemActor("org_home", { guildId, agentId }),
    now,
  );
}

describe("artifact store", { concurrency: 1 }, () => {
  test("tenancy, access lists, reserved paths, embeds, and collections", async () => {
    const now = new Date();
    await insertGuild(db,
      { guildId: "guild_alpha", name: "alpha", orgId: "org_home", about: "" },
      now,
    );
    await insertGuild(db,
      { guildId: "guild_beta", name: "beta", orgId: "org_home", about: "" },
      now,
    );
    await seedAgent("a_alpha", "guild_alpha", "alpha", "art");
    await seedAgent("a_beta", "guild_beta", "beta", "art-beta");

    const operator = operatorActor({
      orgId: "org_home",
      actorId: "user_operator",
      actorName: "operator",
      guildId: "guild_alpha",
      agentId: "a_alpha",
    });
    const alpha = agentActor({
      orgId: "org_home",
      guildId: "guild_alpha",
      agentId: "a_alpha",
      agentName: "alpha",
    });
    const beta = agentActor({
      orgId: "org_home",
      guildId: "guild_beta",
      agentId: "a_beta",
      agentName: "beta",
    });

    const { row: orgNote } = await writeNote(store, operator, {
      level: "org",
      key: "schema.md",
      content: "org schema\n",
    });
    const orgPath = String(artifactView(orgNote).display_path);
    const embeddable = await listEmbeddableNotes(store, operator);
    const preview = embeddable.find((item) => rowDisplayPath(item) === orgPath);
    assert.equal(preview?.content_text, "org schema\n");
    assert.equal(preview?.kind, "note");

    await writeNote(store, alpha, {
      level: "agent",
      key: "secret.md",
      content: "alpha secret\n",
    });
    await writeNote(store, alpha, {
      level: "guild",
      key: "handoff.md",
      content: "guild note\n",
    });

    const orgTarget = { kind: "note" as const, id: orgNote.id };
    await grantAccess(store, operator, orgTarget, { type: "agent", id: "a_alpha", mode: "none" });
    await assert.rejects(() => getByDisplayPath(store, alpha, orgPath), /artifact not found/);
    const operatorSeesDenied = await inlineTaskEmbeds(embedSource(store), operator, `Follow ![[${orgPath}]]\n`);
    assert.match(operatorSeesDenied, /org schema/);
    const alphaSeesMarker = await inlineTaskEmbeds(embedSource(store), alpha, `Follow ![[${orgPath}]]\n`);
    assert.equal(alphaSeesMarker, `Follow ${unreachableMarker(orgPath)}\n`);
    assert.deepEqual(await inspectTaskEmbeds(embedSource(store), alpha, `Follow ![[${orgPath}]]\n`), [
      { href: orgPath, ok: false, reason: "not reachable" },
    ]);
    await grantAccess(store, operator, orgTarget, { type: "agent", id: "a_alpha", mode: null });
    const loadedOrg = await getByDisplayPath(store, alpha, orgPath);
    assert.equal(loadedOrg.row?.content_text, "org schema\n");
    assert.equal(loadedOrg.row?.access, "read");

    await assert.rejects(
      () => getByDisplayPath(store, beta, "org/org_home/agents/a_alpha/secret.md"),
      /artifact not found/,
    );
    await assert.rejects(
      () => getByDisplayPath(store, beta, "org/org_home/guilds/guild_alpha/handoff.md"),
      /artifact not found/,
    );

    await assert.rejects(
      () =>
        writeNote(store, alpha, {
          level: "org",
          key: "published.md",
          content: "nope",
        }),
      /write not allowed/,
    );
    await assert.rejects(
      () =>
        writeNote(store, alpha, {
          level: "agent",
          key: "task.md",
          content: "stolen",
        }),
      /reserved/,
    );
    await assert.rejects(
      () =>
        writeNote(store, operator, {
          level: "org",
          key: "collections/x.md",
          content: "nope",
        }),
      /notes have no folders/,
    );

    await writeAgentTask(db,
      operator,
      "a_alpha",
      `Follow ![[${orgPath}]]\n\nNested stays in the note.\n`,
    );
    const inlined = await inlineTaskEmbeds(
      embedSource(store),
      operator,
      (await getAgentTask(db, operator.orgId, "a_alpha"))?.content_text ?? "",
    );
    assert.match(inlined, /org schema/);
    assert.match(inlined, /<schema path="org\/org_home\/schema\.md" level="org">/);

    const asAgent = await inlineTaskEmbeds(embedSource(store), alpha, `Follow ![[${orgPath}]]\n`);
    assert.match(asAgent, /org schema/);

    await writeNote(store, operator, {
      level: "org",
      key: "nested.md",
      content: `See ![[${orgPath}]]\n`,
    });
    const nested = await inlineTaskEmbeds(embedSource(store), operator, `Use ![[org/org_home/nested.md]]\n`);
    assert.match(nested, /<nested path="org\/org_home\/nested\.md" level="org">/);
    assert.match(nested, /<schema path="org\/org_home\/schema\.md" level="org">/);
    assert.match(nested, /org schema/);
    assert.ok(!nested.includes("See ![["));

    // Collections are managed by the operator at the organisation.
    await assert.rejects(
      () => createCollection(store, alpha, { name: "papers", purpose: "reading list" }),
      (error: Error & { status?: number }) => /managed by the operator/.test(error.message) && error.status === 403,
    );
    await assert.rejects(() => addRecord(store, alpha, { collection: "missing", body: {} }), /unknown collection missing/);
    await assert.rejects(
      () => createCollection(store, operator, { name: "papers", purpose: "reading list", columns: [{ name: "id", type: "text", description: "x" }] }),
      /column "id": name is reserved/,
    );
    const papers = await createCollection(store, operator, {
      name: "papers",
      purpose: "reading list",
      columns: [
        { name: "title", type: "text", description: "paper title", required: true },
        { name: "n", type: "number", description: "citation count" },
        { name: "tags", type: "text", description: "comma-separated tags" },
      ],
    });
    assert.equal(papers.display_path, "org/org_home/collections/papers");
    assert.equal(papers.access, "write");
    assert.deepEqual(
      papers.columns.map((column) => column.name),
      ["title", "n", "tags"],
    );
    await assert.rejects(() => createCollection(store, operator, { name: "papers", purpose: "again" }), /already exists/);

    // An organisation table starts read by the organisation; without that row nobody sees it.
    const target = { kind: "collection" as const, id: papers.id };
    assert.deepEqual(
      (await listAccess(store, operator, target)).map((entry) => [entry.type, entry.id, entry.mode]),
      [["org", "org_home", "read"]],
    );
    assert.equal((await describeCollection(store, beta, "papers"))?.access, "read");
    await grantAccess(store, operator, target, { type: "org", id: "org_home", mode: null });
    assert.equal(await describeCollection(store, alpha, "papers"), null);
    assert.deepEqual(await collectionCatalog(store, alpha), []);
    await assert.rejects(() => addRecord(store, alpha, { collection: "papers", body: { title: "Bees" } }), /unknown collection papers/);
    await assert.rejects(() => listRecords(store, alpha, { collection: "papers" }), /unknown collection papers/);

    await grantAccess(store, operator, target, { type: "guild", id: "guild_alpha", mode: "read" });
    assert.equal((await describeCollection(store, alpha, "papers"))?.access, "read");
    await assert.rejects(
      () => addRecord(store, alpha, { collection: "papers", body: { title: "Bees" } }),
      (error: Error & { status?: number }) => error.message === "no write access to papers" && error.status === 403,
    );
    assert.deepEqual(await listRecords(store, alpha, { collection: "papers" }), { total: 0, records: [], columns: papers.columns });
    const catalog = await collectionCatalog(store, alpha);
    assert.deepEqual(catalog, [
      {
        name: "papers",
        purpose: "reading list",
        access: "read",
        scope: "org",
        display_path: "org/org_home/collections/papers",
        columns: [
          { name: "title", type: "text", required: true, description: "paper title" },
          { name: "n", type: "number", description: "citation count" },
          { name: "tags", type: "text", description: "comma-separated tags" },
        ],
      },
    ]);
    assert.equal(await describeCollection(store, beta, "papers"), null);

    // An agent's own row reaches an organisation table its guild was never given, and the catalog lists it.
    await grantAccess(store, operator, target, { type: "agent", id: "a_beta", mode: "read" });
    assert.equal((await describeCollection(store, beta, "papers"))?.access, "read");
    assert.deepEqual((await collectionCatalog(store, beta)).map((item) => [item.name, item.access]), [["papers", "read"]]);
    await grantAccess(store, operator, target, { type: "agent", id: "a_beta", mode: null });

    // An agent row raises the guild's mode; the operator sees both rows.
    await grantAccess(store, operator, target, { type: "agent", id: "a_alpha", mode: "write" });
    assert.equal((await describeCollection(store, alpha, "papers"))?.access, "write");
    assert.deepEqual(await listAccess(store, operator, target), [
      { type: "guild", id: "guild_alpha", name: "alpha", mode: "read", guild_id: "guild_alpha", guild_name: "alpha" },
      { type: "agent", id: "a_alpha", name: "alpha", mode: "write", guild_id: "guild_alpha", guild_name: "alpha" },
    ]);
    const tablesOf = async (subject: { type: "guild" | "agent"; id: string; guildId: string }) =>
      (await reachOf(store, operator, subject)).tables.map((table) => [table.name, table.mode]);
    assert.deepEqual(await tablesOf({ type: "guild", id: "guild_beta", guildId: "guild_beta" }), []);
    assert.deepEqual(await tablesOf({ type: "guild", id: "guild_alpha", guildId: "guild_alpha" }), [["papers", "read"]]);
    assert.deepEqual(await tablesOf({ type: "agent", id: "a_alpha", guildId: "guild_alpha" }), [["papers", "write"]]);
    // the agent's own row overrides its guild's mode, and `none` keeps it out
    await grantAccess(store, operator, target, { type: "agent", id: "a_alpha", mode: "none" });
    assert.equal(await describeCollection(store, alpha, "papers"), null);
    assert.deepEqual(await collectionCatalog(store, alpha), []);
    await assert.rejects(() => listRecords(store, alpha, { collection: "papers" }), /unknown collection papers/);
    assert.deepEqual(await tablesOf({ type: "agent", id: "a_alpha", guildId: "guild_alpha" }), []);
    await assert.rejects(
      () => grantAccess(store, operator, target, { type: "guild", id: "guild_alpha", mode: "none" }),
      /mode must be read or write/,
    );
    await grantAccess(store, operator, target, { type: "agent", id: "a_alpha", mode: "write" });
    await assert.rejects(
      () => grantAccess(store, operator, target, { type: "agent", id: "a_nobody", mode: "read" }),
      /unknown agent/,
    );
    await assert.rejects(
      () => replaceAccess(store, operator, target, [{ type: "team", id: "guild_alpha", mode: "read" }]),
      /type must be org, guild, or agent/,
    );
    await assert.rejects(
      () => grantAccess(store, alpha, target, { type: "guild", id: "guild_alpha", mode: "read" }),
      /managed by the operator/,
    );

    const added = await addRecord(store, alpha, { collection: "papers", body: { title: "Bees", n: 1, tags: "insects" } });
    assert.equal(added.merged, null);
    assert.equal(added.record.id, 1);
    assert.equal(added.record.collection, "papers");
    assert.equal(added.record.title, "Bees");
    assert.equal(added.record.updated_by, "alpha");
    assert.ok(!("display_path" in added.record));
    assert.match(String(added.record.created_at), /^\d{4}-\d{2}-\d{2}T/);
    assert.equal(await getRecord(store, alpha, "papers", 1).then((record) => record.n), 1);
    await assert.rejects(() => getRecord(store, beta, "papers", 1), /unknown collection papers/);
    const loaded = await getByDisplayPath(store, operator, "org/org_home/collections/papers/1");
    assert.equal(loaded.row?.kind, "object");
    assert.equal(artifactView(loaded.row!).display_path, "org/org_home/collections/papers/1");
    assert.equal((await listCollectionsWithCounts(store, operator))[0]?.count, 1);

    // Column changes reshape the live records.
    const reshaped = await updateCollection(store, operator, papers.id, {
      purpose: "updated reading list",
      columns: [
        { name: "title", type: "text", description: "paper title", required: true, unique: true },
        { name: "citations", rename_from: "n", type: "number", description: "citation count" },
        { name: "status", type: "text", description: "review state", values: ["unread", "read"] },
      ],
    });
    assert.equal(reshaped.purpose, "updated reading list");
    assert.deepEqual(
      reshaped.columns.map((column) => column.name),
      ["title", "citations", "status"],
    );
    assert.equal(reshaped.count, 1);
    const moved = await getRecord(store, operator, "papers", 1);
    assert.equal(moved.citations, 1);
    assert.equal("n" in moved, false);
    assert.equal("tags" in moved, false);
    // the renamed unique column now dedupes on title
    const merged = await addRecord(store, alpha, { collection: "papers", body: { title: " bees ", status: "read" } });
    assert.equal(merged.merged, 1);
    assert.equal(merged.record.status, "read");
    assert.equal(merged.record.citations, 1);
    await assert.rejects(
      () => addRecord(store, alpha, { collection: "papers", body: { title: "Ants", status: "skimmed" } }),
      /record rejected\n- column "status": expected one of unread, read; got "skimmed"/,
    );
    await addRecord(store, alpha, { collection: "papers", body: { title: "Ants" } });
    // a null value never repeats; once both records carry the same count the column cannot become unique
    await updateRecord(store, alpha, { collection: "papers", id: 2, body: { citations: 1 } });
    await assert.rejects(
      () =>
        updateCollection(store, operator, papers.id, {
          columns: [
            { name: "title", type: "text", description: "paper title", required: true },
            { name: "citations", type: "number", description: "citation count", unique: true },
            { name: "status", type: "text", description: "review state", values: ["unread", "read"] },
          ],
        }),
      /column "citations" cannot be unique while live records repeat: 1/,
    );
    await assert.rejects(() => updateCollection(store, operator, papers.id, { name: "Papers!" }), /collection name must match/);

    // Deleting a collection removes its records and its access list.
    await deleteCollection(store, operator, papers.id);
    assert.equal(await describeCollection(store, alpha, "papers"), null);
    await assert.rejects(() => getCollection(store, operator, papers.id), /unknown collection/);
    assert.deepEqual(await tablesOf({ type: "guild", id: "guild_alpha", guildId: "guild_alpha" }), []);
    const gone = await database.pool.query(`SELECT count(*)::int AS n FROM artifacts WHERE collection_id = $1 AND deleted_at IS NULL`, [papers.id]);
    assert.equal(gone.rows[0]?.n, 0);
    const [deletedLog] = await listConfigChanges(database.pool, operator.orgId, { kind: "collection", id: papers.id });
    assert.equal(deletedLog?.operation, "delete");
    assert.equal(deletedLog?.summary, "Deleted the table papers");
    const rows = await database.pool.query(
      `SELECT count(*)::int AS n FROM artifact_access WHERE target_kind = 'collection' AND target_id = $1`,
      [papers.id],
    );
    assert.equal(rows.rows[0]?.n, 0);
    // the name is free again
    const again = await createCollection(store, operator, { name: "papers", purpose: "fresh" });
    assert.notEqual(again.id, papers.id);
    assert.equal((await addRecord(store, operator, { collection: "papers", body: {} })).record.id, 1);
  });

  test("records: validation, ids, identity merge, where, since, order, and search", async () => {
    const now = new Date();
    await insertGuild(db,
      { guildId: "guild_search", name: "search", orgId: "org_home", about: "" },
      now,
    );
    await seedAgent("a_search", "guild_search", "searcher", "search");
    const searcher = agentActor({
      orgId: "org_home",
      guildId: "guild_search",
      agentId: "a_search",
      agentName: "searcher",
    });
    const operator = operatorActor({
      orgId: "org_home",
      actorId: "user_operator",
      actorName: "operator",
      guildId: "guild_search",
      agentId: "a_search",
    });
    const packets = await createCollection(store, operator, {
      name: "packets",
      purpose: "research packets",
      columns: [
        { name: "project", type: "text", description: "project name", required: true, unique: true },
        { name: "handled", type: "boolean", description: "picked up", required: true },
        { name: "chain", type: "text", description: "chain the project runs on" },
        { name: "status", type: "text", description: "queue state", values: ["open", "blocked", "closed"] },
        { name: "novelty", type: "number", description: "novelty score" },
        { name: "seen_at", type: "datetime", description: "when it was first seen" },
      ],
    });
    await grantAccess(store, operator, { kind: "collection", id: packets.id }, { type: "guild", id: "guild_search", mode: "write" });
    await grantAccess(store, operator, { kind: "collection", id: packets.id }, { type: "org", id: "org_home", mode: null });

    // every problem at once, nothing written
    await assert.rejects(
      () => addRecord(store, searcher, { collection: "packets", body: { chain: 5, status: "new", novelty: "1", seen_at: "yesterday", extra: 1 } }),
      (error: Error & { status?: number }) => {
        assert.equal(error.status, 422);
        assert.equal(
          error.message,
          [
            "record rejected",
            '- column "extra": unknown column; declared columns are project, handled, chain, status, novelty, seen_at',
            '- column "project": required',
            '- column "handled": required',
            '- column "chain": expected text; got 5',
            '- column "status": expected one of open, blocked, closed; got "new"',
            '- column "novelty": expected number; got "1"',
            '- column "seen_at": expected an ISO 8601 datetime with a timezone; got "yesterday"',
          ].join("\n"),
        );
        return true;
      },
    );
    assert.equal((await listRecords(store, searcher, { collection: "packets" })).total, 0);

    const add = (body: Record<string, unknown>) => addRecord(store, searcher, { collection: "packets", body });
    const zebra = await add({ project: "Zebra", handled: true, chain: "claimed Zcash launchpad", status: "blocked", novelty: 1, seen_at: "2025-03-14T08:00:00Z" });
    const zecord = await add({ project: "Zecord", handled: false, chain: "Solana", status: "open", novelty: 3, seen_at: "2025-03-14T09:00:00+01:00" });
    const anthood = await add({ project: "AntHood", handled: false, chain: "Robinhood Chain", status: "open", novelty: 1, seen_at: "2025-03-13T08:00:00Z" });
    assert.deepEqual([zebra.record.id, zecord.record.id, anthood.record.id], [1, 2, 3]);
    assert.equal(zecord.record.seen_at, "2025-03-14T08:00:00.000Z");

    // the unique column merges a repeat into the existing record, keeping what the body leaves out
    const repeat = await add({ project: " zebra ", handled: true, chain: "Zcash" });
    assert.equal(repeat.merged, 1);
    assert.equal(repeat.record.id, 1);
    assert.equal(repeat.record.chain, "Zcash");
    assert.equal(repeat.record.status, "blocked");
    assert.equal(repeat.record.novelty, 1);
    assert.equal((await listRecords(store, searcher, { collection: "packets" })).total, 3);

    // update: only the patched columns are validated, null clears, ids are never invented
    const patched = await updateRecord(store, searcher, { collection: "packets", id: "2", body: { handled: true, novelty: null } });
    assert.equal(patched.record.handled, true);
    assert.equal("novelty" in patched.record, false);
    assert.deepEqual(patched.warnings, []);
    await assert.rejects(
      () => updateRecord(store, searcher, { collection: "packets", id: 2, body: { project: null } }),
      /column "project": required; cannot be cleared/,
    );
    await assert.rejects(
      () => updateRecord(store, searcher, { collection: "packets", id: 2, body: { project: "AntHood" } }),
      (error: Error & { status?: number }) => error.status === 409 && /another record already holds that project: record 3 already holds that value/.test(error.message),
    );
    await assert.rejects(() => updateRecord(store, searcher, { collection: "packets", id: 99, body: { handled: true } }), /record 99 not found/);
    await assert.rejects(() => updateRecord(store, searcher, { collection: "packets", id: "two", body: {} }), /id must be a positive integer/);

    // a column change leaves old values in place; the next update reports them without blocking
    await updateCollection(store, operator, packets.id, {
      columns: [
        { name: "project", type: "text", description: "project name", required: true, unique: true },
        { name: "handled", type: "boolean", description: "picked up", required: true },
        { name: "chain", type: "text", description: "chain the project runs on" },
        { name: "status", type: "text", description: "queue state", values: ["open", "closed"] },
        { name: "novelty", type: "number", description: "novelty score" },
        { name: "seen_at", type: "datetime", description: "when it was first seen" },
        { name: "owner", type: "text", description: "who follows it", required: true },
      ],
    });
    const warned = await updateRecord(store, searcher, { collection: "packets", id: 1, body: { chain: "Zcash mainnet" } });
    assert.deepEqual(warned.warnings, ['column "status": expected one of open, closed; got "blocked"', 'column "owner": required']);
    await updateRecord(store, searcher, { collection: "packets", id: 1, body: { status: "closed", owner: "desk" } });
    await updateRecord(store, searcher, { collection: "packets", id: 2, body: { owner: "desk" } });
    await updateRecord(store, searcher, { collection: "packets", id: 3, body: { owner: "scout" } });

    const list = async (args: Record<string, unknown>) =>
      (await listRecords(store, searcher, { collection: "packets", ...args })).records.map((row) => row.id);

    // where: text by substring and similar spelling, a closed list exactly, others exactly or by range, null for missing
    assert.deepEqual(await list({ where: { chain: "solana" } }), [2]);
    assert.deepEqual(await list({ where: { project: "Anthod" } }), [3]);
    assert.deepEqual(await list({ where: { project: "zecor" } }), [2]);
    assert.deepEqual(await list({ where: { status: "open" } }), [2, 3]);
    assert.deepEqual(await list({ where: { handled: false } }), [3]);
    assert.deepEqual(await list({ where: { novelty: 1 } }), [1, 3]);
    assert.deepEqual(await list({ where: { novelty: { gte: 1 } } }), [1, 3]);
    assert.deepEqual(await list({ where: { novelty: null } }), [2]);
    assert.deepEqual(await list({ where: { seen_at: { gte: "2025-03-14T00:00:00Z" } } }), [1, 2]);
    assert.deepEqual(await list({ where: { seen_at: "2025-03-13T09:00:00+01:00" } }), [3]);
    assert.deepEqual(await list({ where: { id: 3 } }), [3]);
    assert.deepEqual(await list({ where: { status: "open", owner: "scout" } }), [3]);
    await assert.rejects(() => list({ where: { status: "pending" } }), /where\.status: expected one of open, closed; got "pending"/);
    await assert.rejects(() => list({ where: { nope: 1 } }), /where\.nope: unknown column/);

    // order, paging, and total
    assert.deepEqual(await list({ order: { column: "novelty", direction: "desc" } }), [3, 1, 2]);
    assert.deepEqual(await list({ order: "seen_at" }), [3, 1, 2]);
    assert.deepEqual(await list({ order: { column: "project" } }), [3, 1, 2]);
    const paged = await listRecords(store, searcher, { collection: "packets", limit: 2, offset: 1 });
    assert.equal(paged.total, 3);
    assert.deepEqual(paged.records.map((row) => row.id), [2, 3]);

    // since: only records changed at or after the cursor, oldest change first
    const all = (await listRecords(store, searcher, { collection: "packets", order: "updated_at" })).records;
    const stamps = all.map((row) => String(row.updated_at));
    assert.ok(stamps.every((stamp) => /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/.test(stamp)), stamps.join(","));
    assert.deepEqual(await list({ since: stamps[stamps.length - 1] }), [3]);
    assert.deepEqual(await list({ since: "2000-01-01T00:00:00Z" }), all.map((row) => row.id));
    assert.deepEqual(await list({ since: "2999-01-01T00:00:00Z" }), []);
    await assert.rejects(() => list({ since: "last week" }), /ISO 8601/);

    // search: whole words, OR, phrase, exclusion, single-token substring; never fuzzy
    const search = async (args: { collection?: string; query: string; where?: unknown }) =>
      (await searchRecords(store, searcher, args)).records.map((row) => `${row.collection}/${row.id}`);
    assert.deepEqual(await search({ query: "Solana" }), ["packets/2"]);
    assert.deepEqual(await search({ query: "Zcash mainnet" }), ["packets/1"]);
    assert.deepEqual(new Set(await search({ query: "Zebra OR AntHood" })), new Set(["packets/1", "packets/3"]));
    assert.deepEqual(await search({ query: "open -Solana" }), ["packets/3"]);
    assert.deepEqual(await search({ query: '"Robinhood Chain"' }), ["packets/3"]);
    assert.deepEqual(await search({ query: "Zecor" }), ["packets/2"]);
    assert.deepEqual(await search({ query: "Zecrod" }), []);
    assert.deepEqual(await search({ query: "handled" }), []);
    assert.deepEqual(await search({ query: "open", collection: "packets", where: { owner: "scout" } }), ["packets/3"]);
    await assert.rejects(() => search({ query: "open", where: { owner: "scout" } }), /where needs a collection/);
    await assert.rejects(() => searchRecords(store, searcher, { query: "  " }), /query is required/);

    // facts for the empty-result hint
    const facts = await collectionFacts(store, searcher, "packets");
    assert.equal(facts?.count, 3);
    assert.equal(facts?.newest_updated_at, stamps[stamps.length - 1]);
    assert.deepEqual(facts?.columns.map((column) => column.name), ["project", "handled", "chain", "status", "novelty", "seen_at", "owner"]);
    assert.equal(await collectionFacts(store, searcher, "nope"), null);
    const outsider = agentActor({
      orgId: "org_home",
      guildId: "guild_alpha",
      agentId: "a_alpha",
      agentName: "alpha",
    });
    assert.equal(await collectionFacts(store, outsider, "packets"), null);
    assert.deepEqual(await search({ query: "Solana" }).then(() => searchRecords(store, outsider, { query: "Solana" })), { records: [] });

    // remove: soft, ids are never reused, provenance is recorded
    assert.equal(await removeRecord(store, searcher, { collection: "packets", id: 3 }), 3);
    await assert.rejects(() => removeRecord(store, searcher, { collection: "packets", id: 3 }), /record 3 not found/);
    assert.deepEqual(await list({}), [1, 2]);
    const next = await add({ project: "AntHood", handled: false, owner: "scout" });
    assert.equal(next.record.id, 4);
    const tombstone = await getByDisplayPath(store, operator, "org/org_home/collections/packets/3");
    assert.equal(tombstone.tombstone, true);
    const changes = await listFileChanges(database.pool, "org_home", "org/org_home/collections/packets/3");
    assert.deepEqual(changes.map((change) => change.operation), ["delete", "update", "create"]);
    const exported = await exportRecords(store, operator, packets.id);
    assert.deepEqual(exported.records.map((row) => row.id), [1, 2, 4]);
    assert.equal(exported.name, "packets");
  });

  test("operator can clear every live record without deleting the collection", async () => {
    const now = new Date();
    await insertGuild(db,
      { guildId: "guild_scratch", name: "scratch", orgId: "org_home", about: "" },
      now,
    );
    await seedAgent("a_scratch", "guild_scratch", "scratcher", "scratch");
    const writer = agentActor({
      orgId: "org_home",
      guildId: "guild_scratch",
      agentId: "a_scratch",
      agentName: "scratcher",
    });
    const operator = operatorActor({
      orgId: "org_home",
      actorId: "user_operator",
      actorName: "operator",
      guildId: "guild_scratch",
      agentId: "a_scratch",
    });
    const scratch = await createCollection(store, operator, {
      name: "scratch",
      purpose: "throwaway rows",
      columns: [{ name: "title", type: "text", description: "row title", required: true, unique: true }],
    });
    await grantAccess(store, operator, { kind: "collection", id: scratch.id }, { type: "guild", id: "guild_scratch", mode: "write" });
    await addRecord(store, writer, { collection: "scratch", body: { title: "one" } });
    await addRecord(store, writer, { collection: "scratch", body: { title: "two" } });
    await addRecord(store, writer, { collection: "scratch", body: { title: "three" } });

    await assert.rejects(() => clearRecords(store, writer, scratch.id), /managed by the operator/);
    assert.equal(await clearRecords(store, operator, scratch.id), 3);
    assert.deepEqual((await listRecords(store, writer, { collection: "scratch" })).records, []);
    assert.equal((await getCollection(store, operator, scratch.id)).count, 0);
    const rows = await listAccess(store, operator, { kind: "collection", id: scratch.id });
    assert.equal(rows.some((row) => row.id === "guild_scratch" && row.mode === "write"), true);
    const again = await addRecord(store, writer, { collection: "scratch", body: { title: "one" } });
    assert.equal(again.record.id, 4);
    assert.equal(again.merged, null);
    assert.equal(await clearRecords(store, operator, scratch.id), 1);
    assert.equal(await clearRecords(store, operator, scratch.id), 0);
    await assert.rejects(() => clearRecords(store, operator, "col_missing"), /unknown collection/);
    // Each Delete all that removed records is logged once; the one that found none is not.
    const cleared = await listConfigChanges(database.pool, operator.orgId, { kind: "collection", id: scratch.id });
    assert.deepEqual(
      cleared.map((change) => [change.summary, change.actor.type]),
      [
        ["Deleted all 1 record of scratch", "user"],
        ["Deleted all 3 records of scratch", "user"],
        ["Gave guild scratch read and write on the table scratch", "user"],
      ],
    );
  });

  test("an array column stores a list of text and where matches an item like text", async () => {
    const now = new Date();
    await insertGuild(db,
      { guildId: "guild_tags", name: "tags", orgId: "org_home", about: "" },
      now,
    );
    await seedAgent("a_tags", "guild_tags", "tagger", "tags");
    const tagger = agentActor({
      orgId: "org_home",
      guildId: "guild_tags",
      agentId: "a_tags",
      agentName: "tagger",
    });
    const operator = operatorActor({
      orgId: "org_home",
      actorId: "user_operator",
      actorName: "operator",
      guildId: "guild_tags",
      agentId: "a_tags",
    });
    const notes = await createCollection(store, operator, {
      name: "tagged-notes",
      purpose: "notes with labels",
      columns: [
        { name: "title", type: "text", description: "note title", required: true },
        { name: "tags", type: "array", description: "labels" },
        { name: "kind", type: "array", description: "closed labels", values: ["work", "home"] },
      ],
    });
    await grantAccess(store, operator, { kind: "collection", id: notes.id }, { type: "guild", id: "guild_tags", mode: "write" });

    await assert.rejects(
      () => addRecord(store, tagger, { collection: "tagged-notes", body: { title: "one", tags: "solo", kind: ["play"] } }),
      /column "tags": expected a list of text; got "solo"[\s\S]*column "kind": item 1: expected one of work, home; got "play"/,
    );

    const first = await addRecord(store, tagger, {
      collection: "tagged-notes",
      body: { title: "alpha", tags: ["crm", "warm", "solana"], kind: ["work"] },
    });
    await addRecord(store, tagger, {
      collection: "tagged-notes",
      body: { title: "beta", tags: ["crm"], kind: ["home"] },
    });
    const empty = await addRecord(store, tagger, { collection: "tagged-notes", body: { title: "gamma", tags: [] } });
    await addRecord(store, tagger, { collection: "tagged-notes", body: { title: "delta" } });
    assert.deepEqual(first.record.tags, ["crm", "warm", "solana"]);
    assert.deepEqual(first.record.kind, ["work"]);
    assert.deepEqual(empty.record.tags, []);

    const list = async (where: Record<string, unknown>) =>
      (await listRecords(store, tagger, { collection: "tagged-notes", where })).records.map((row) => row.id);
    assert.deepEqual(await list({ tags: "crm" }), [1, 2]);
    assert.deepEqual(await list({ tags: "cr" }), [1, 2]);
    assert.deepEqual(await list({ tags: "warm" }), [1]);
    assert.deepEqual(await list({ tags: "solanna" }), [1]);
    assert.deepEqual(await list({ kind: "home" }), [2]);
    assert.deepEqual(await list({ tags: null }), [4]);
    await assert.rejects(() => list({ kind: "play" }), /where\.kind: expected one of work, home/);
    await assert.rejects(
      () => listRecords(store, tagger, { collection: "tagged-notes", order: { column: "tags" } }),
      /order\.column cannot be an array column/,
    );

    const patched = await updateRecord(store, tagger, { collection: "tagged-notes", id: 1, body: { tags: ["warm"] } });
    assert.deepEqual(patched.record.tags, ["warm"]);
    assert.deepEqual(await list({ tags: "crm" }), [2]);
  });

  test("a guild's own table: its guild row lets members write, other guilds need a row, it moves and dies with the guild", async () => {
    const now = new Date();
    await insertGuild(db,
      { guildId: "guild_own", name: "own", orgId: "org_home", about: "" },
      now,
    );
    await insertGuild(db,
      { guildId: "guild_other", name: "other", orgId: "org_home", about: "" },
      now,
    );
    await seedAgent("a_own", "guild_own", "owner-agent", "own");
    await seedAgent("a_other", "guild_other", "other-agent", "other");
    const operator = operatorActor({ orgId: "org_home", actorId: "user_operator", actorName: "operator" });
    const member = agentActor({ orgId: "org_home", guildId: "guild_own", agentId: "a_own", agentName: "owner-agent" });
    const outsider = agentActor({ orgId: "org_home", guildId: "guild_other", agentId: "a_other", agentName: "other-agent" });

    await assert.rejects(
      () => createCollection(store, operator, { name: "own-notes", purpose: "the guild's scratch table", guildId: "guild_nope" }),
      /unknown guild/,
    );
    const own = await createCollection(store, operator, {
      name: "own-notes",
      purpose: "the guild's scratch table",
      columns: [{ name: "note", type: "text", description: "what was noted", required: true }],
      guildId: "guild_own",
    });
    const target = { kind: "collection" as const, id: own.id };
    assert.equal(own.scope, "guild");
    assert.deepEqual(own.guild, { id: "guild_own", name: "own" });
    assert.deepEqual(await listAccess(store, operator, target), [
      { type: "guild", id: "guild_own", name: "own", mode: "write", guild_id: "guild_own", guild_name: "own" },
    ]);

    // members write through the guild row; other guilds do not see it
    const added = await addRecord(store, member, { collection: "own-notes", body: { note: "first" } });
    assert.equal(added.record.id, 1);
    assert.equal((await describeCollection(store, member, "own-notes"))?.access, "write");
    assert.equal(await describeCollection(store, outsider, "own-notes"), null);
    await assert.rejects(() => listRecords(store, outsider, { collection: "own-notes" }), /unknown collection own-notes/);
    assert.deepEqual((await searchRecords(store, outsider, { query: "first" })).records, []);
    assert.deepEqual((await searchRecords(store, member, { query: "first" })).records.map((row) => row.id), [1]);
    const listed = async (actor: typeof member) =>
      (await collectionCatalog(store, actor)).filter((item) => item.name === "own-notes").map((item) => [item.name, item.scope, item.access]);
    assert.deepEqual(await listed(member), [["own-notes", "guild", "write"]]);
    assert.deepEqual(await listed(outsider), []);

    // a row for another guild shares it like any other table
    await grantAccess(store, operator, target, { type: "guild", id: "guild_other", mode: "read" });
    assert.equal((await describeCollection(store, outsider, "own-notes"))?.access, "read");
    await grantAccess(store, operator, target, { type: "guild", id: "guild_other", mode: null });

    // an agent row keeps one member out of its own guild's table
    await grantAccess(store, operator, target, { type: "agent", id: "a_own", mode: "none" });
    assert.equal(await describeCollection(store, member, "own-notes"), null);
    await assert.rejects(() => listRecords(store, member, { collection: "own-notes" }), /unknown collection own-notes/);
    assert.deepEqual((await searchRecords(store, member, { query: "first" })).records, []);
    assert.deepEqual(await listed(member), []);
    await grantAccess(store, operator, target, { type: "agent", id: "a_own", mode: "read" });
    assert.equal((await describeCollection(store, member, "own-notes"))?.access, "read");
    await assert.rejects(() => addRecord(store, member, { collection: "own-notes", body: { note: "x" } }), /no write access to own-notes/);
    await grantAccess(store, operator, target, { type: "agent", id: "a_own", mode: null });
    assert.equal((await describeCollection(store, member, "own-notes"))?.access, "write");

    // the guild reaches its own table beside the organisation tables its rows give it
    const shared = await createCollection(store, operator, { name: "shared-notes", purpose: "an organisation table" });
    await grantAccess(store, operator, { kind: "collection", id: shared.id }, { type: "guild", id: "guild_own", mode: "write" });
    const ours = (rows: Array<{ name: string; mode: string }>) =>
      rows.filter((row) => row.name === "own-notes" || row.name === "shared-notes").map((row) => [row.name, row.mode]);
    const reachedBy = async (type: "guild" | "agent", id: string, guildId: string) =>
      ours((await reachOf(store, operator, { type, id, guildId })).tables);
    assert.deepEqual(await reachedBy("guild", "guild_own", "guild_own"), [["own-notes", "write"], ["shared-notes", "write"]]);
    assert.deepEqual(await reachedBy("guild", "guild_other", "guild_other"), [["shared-notes", "read"]]);
    assert.deepEqual(await reachedBy("agent", "a_own", "guild_own"), [["own-notes", "write"], ["shared-notes", "write"]]);

    // moving a table is placement only: its access list stays
    const promoted = await updateCollection(store, operator, own.id, { guildId: null });
    assert.equal(promoted.scope, "org");
    assert.equal(promoted.guild, null);
    assert.equal((await describeCollection(store, member, "own-notes"))?.access, "write");
    assert.equal(await describeCollection(store, outsider, "own-notes"), null);
    const moved = await updateCollection(store, operator, own.id, { guildId: "guild_other" });
    assert.equal(moved.guild?.id, "guild_other");
    assert.equal((await describeCollection(store, member, "own-notes"))?.access, "write");
    assert.equal(await describeCollection(store, outsider, "own-notes"), null);
    assert.deepEqual((await listAccess(store, operator, target)).map((row) => [row.type, row.id, row.mode]), [["guild", "guild_own", "write"]]);

    // deleting a guild soft-deletes its own tables and their records, and drops their access lists
    await deleteGuild(db, "guild_other");
    await assert.rejects(() => getCollection(store, operator, own.id), /unknown collection/);
    const records = await database.pool.query(
      `SELECT count(*)::int AS n FROM artifacts WHERE collection_id = $1 AND deleted_at IS NULL`,
      [own.id],
    );
    assert.equal(records.rows[0]?.n, 0);
    const rows = await database.pool.query(
      `SELECT count(*)::int AS n FROM artifact_access WHERE target_kind = 'collection' AND target_id = $1`,
      [own.id],
    );
    assert.equal(rows.rows[0]?.n, 0);
    assert.equal((await getCollection(store, operator, shared.id)).name, "shared-notes");
  });

  test("note access lists: defaults at creation, guild and org rows, agent rows, writes, and the change log", async () => {
    const now = new Date();
    await insertGuild(db,
      { guildId: "guild_north", name: "north", orgId: "org_home", about: "" },
      now,
    );
    await insertGuild(db,
      { guildId: "guild_south", name: "south", orgId: "org_home", about: "" },
      now,
    );
    await seedAgent("a_north", "guild_north", "north-agent", "north");
    await seedAgent("a_south", "guild_south", "south-agent", "south");
    await seedAgent("a_south2", "guild_south", "south-two", "south2");
    const operator = operatorActor({ orgId: "org_home", actorId: "user_operator", actorName: "operator" });
    const north = agentActor({ orgId: "org_home", guildId: "guild_north", agentId: "a_north", agentName: "north-agent" });
    const south = agentActor({ orgId: "org_home", guildId: "guild_south", agentId: "a_south", agentName: "south-agent" });
    const southTwo = agentActor({ orgId: "org_home", guildId: "guild_south", agentId: "a_south2", agentName: "south-two" });
    const rowsOf = async (id: string) =>
      (await listAccess(store, operator, { kind: "note", id })).map((row) => [row.type, row.id, row.mode]);
    const found = async (actor: typeof north, query: string) =>
      (await findNotes(store, actor, { query })).notes.map((note) => [note.display_path, note.access]);

    // default rows: a guild note is written by its guild, an org note read by the organisation, an agent note has none
    const { row: plan } = await writeNote(store, north, { level: "guild", key: "plan.md", content: "north plan\n" });
    const planPath = String(artifactView(plan).display_path);
    const { row: own } = await writeNote(store, north, { level: "agent", key: "mine.md", content: "north private\n" });
    const { row: handbook } = await writeNote(store, operator, { level: "org", key: "handbook.md", content: "org handbook\n" });
    const handbookPath = String(artifactView(handbook).display_path);
    assert.deepEqual(await rowsOf(plan.id), [["guild", "guild_north", "write"]]);
    assert.deepEqual(await rowsOf(own.id), []);
    assert.deepEqual(await rowsOf(handbook.id), [["org", "org_home", "read"]]);
    assert.deepEqual(await found(north, "plan"), [[planPath, "write"]]);
    assert.deepEqual(await found(south, "plan"), []);
    assert.deepEqual(await found(south, "handbook"), [[handbookPath, "read"]]);
    assert.deepEqual(await found(south, "private"), []);

    // a guild row covers an agent created after it
    await seedAgent("a_north_late", "guild_north", "north-late", "north-late");
    const late = agentActor({ orgId: "org_home", guildId: "guild_north", agentId: "a_north_late", agentName: "north-late" });
    assert.equal((await getByDisplayPath(store, late, planPath)).row?.access, "write");

    // shared with a second guild at read: found by its agents, refused on write
    await grantAccess(store, operator, { kind: "note", id: plan.id }, { type: "guild", id: "guild_south", mode: "read" });
    assert.deepEqual(await found(south, "plan"), [[planPath, "read"]]);
    await assert.rejects(() => writeNoteAt(store, south, planPath, "overwritten"), /write not allowed/);
    await assert.rejects(() => deleteByDisplayPath(store, south, planPath), /write not allowed/);
    const [writeRefused] = await invokeTool(
      createToolContext({
        run_id: "r_south",
        agent_id: "a_south",
        guild_id: "guild_south",
        sandbox: null,
        secrets: {},
        artifacts: toolArtifacts(store),
        artifact_actor: south,
      }),
      { id: "call_write", type: "function", function: { name: "note_write", arguments: JSON.stringify({ path: planPath, content: "overwritten" }) } },
      {},
      32_768,
    );
    assert.match(String(writeRefused.content), /write not allowed/);

    // an agent row raises one agent to write, and `none` hides the note from that agent alone
    await grantAccess(store, operator, { kind: "note", id: plan.id }, { type: "agent", id: "a_south", mode: "write" });
    await writeNoteAt(store, south, planPath, "south edit\n");
    assert.equal((await getByDisplayPath(store, north, planPath)).row?.content_text, "south edit\n");
    await grantAccess(store, operator, { kind: "note", id: plan.id }, { type: "agent", id: "a_south", mode: "none" });
    assert.deepEqual(await found(south, "plan"), []);
    await assert.rejects(() => getByDisplayPath(store, south, planPath), /artifact not found/);
    assert.deepEqual(await found(southTwo, "plan"), [[planPath, "read"]]);

    // an agent shut out of a note of its own guild is refused the write, not told the note is missing
    await grantAccess(store, operator, { kind: "note", id: plan.id }, { type: "agent", id: "a_north_late", mode: "none" });
    await assert.rejects(() => writeNote(store, late, { level: "guild", key: "plan.md", content: "x" }), /write not allowed/);
    await assert.rejects(() => writeNoteAt(store, late, planPath, "x"), /artifact not found/);
    await grantAccess(store, operator, { kind: "note", id: plan.id }, { type: "agent", id: "a_north_late", mode: null });

    // org level: an agent creates no org note, and updates one only with write access
    await assert.rejects(() => writeNote(store, north, { level: "org", key: "fresh.md", content: "x" }), /write not allowed/);
    await assert.rejects(() => writeNote(store, north, { level: "org", key: "handbook.md", content: "x" }), /write not allowed/);
    await grantAccess(store, operator, { kind: "note", id: handbook.id }, { type: "guild", id: "guild_north", mode: "write" });
    await writeNote(store, north, { level: "org", key: "handbook.md", content: "north handbook\n" });
    assert.equal((await getByDisplayPath(store, south, handbookPath)).row?.content_text, "north handbook\n");

    // the full list replaces the rows and logs one change per subject whose row changes
    const replaced = await replaceAccess(store, operator, { kind: "note", id: plan.id }, [
      { type: "guild", id: "guild_north", mode: "write" },
      { type: "org", id: "org_home", mode: "read" },
    ]);
    assert.deepEqual(replaced.subjects.map((row) => [row.type, row.id, row.mode]), [
      ["org", "org_home", "read"],
      ["guild", "guild_north", "write"],
    ]);
    assert.equal(replaced.owner_agent_id, null);
    assert.deepEqual(await found(southTwo, "plan"), [[planPath, "read"]]);
    const log = await listConfigChanges(database.pool, operator.orgId, { kind: "note", id: plan.id });
    assert.deepEqual(
      log.slice(0, 3).map((entry) => entry.summary).sort(),
      [
        `Gave the organisation read on the note ${planPath}`,
        `Removed agent south-agent from the access of the note ${planPath}`,
        `Removed guild south from the access of the note ${planPath}`,
      ],
    );
    await assert.rejects(
      () =>
        replaceAccess(store, operator, { kind: "note", id: plan.id }, [
          { type: "guild", id: "guild_north", mode: "write" },
          { type: "guild", id: "guild_north", mode: "read" },
        ]),
      { status: 422, message: "subjects[1]: the subject appears more than once" },
    );

    // the agent that owns a note always writes it: no row may name it
    assert.equal((await accessList(store, operator, { kind: "note", id: own.id })).owner_agent_id, "a_north");
    await assert.rejects(
      () => replaceAccess(store, operator, { kind: "note", id: own.id }, [{ type: "agent", id: "a_north", mode: "none" }]),
      { status: 422, message: "subjects[0]: the agent that owns the note always writes it" },
    );
    await assert.rejects(
      () => grantAccess(store, operator, { kind: "note", id: own.id }, { type: "agent", id: "a_north", mode: "read" }),
      { status: 422, message: "the agent that owns the note always writes it" },
    );

    // a subject that does not exist is a fault of the body, named by its place in the list
    await assert.rejects(
      () =>
        replaceAccess(store, operator, { kind: "note", id: plan.id }, [
          { type: "org", id: "org_home", mode: "read" },
          { type: "guild", id: "guild_gone", mode: "read" },
        ]),
      { status: 422, message: "subjects[1]: unknown guild" },
    );

    // a row whose subject is gone does not block the list, and is removed with it
    await database.pool.query(
      `INSERT INTO artifact_access (
         id, org_id, target_kind, target_id, subject_type, subject_id, mode,
         created_by_type, created_by_id, created_by_name, created_at,
         updated_by_type, updated_by_id, updated_by_name, updated_at
       ) VALUES ('aacc_stale', 'org_home', 'note', $1, 'guild', 'guild_gone', 'read',
                 'user', 'user_operator', 'operator', now(), 'user', 'user_operator', 'operator', now())`,
      [plan.id],
    );
    await replaceAccess(store, operator, { kind: "note", id: plan.id }, [
      { type: "org", id: "org_home", mode: "read" },
      { type: "guild", id: "guild_north", mode: "read" },
    ]);
    assert.deepEqual(await rowsOf(plan.id), [["org", "org_home", "read"], ["guild", "guild_north", "read"]]);

    // a changed row keeps who created it and records who changed it
    const stamps = await database.pool.query(
      `SELECT created_by_name, updated_by_name FROM artifact_access
        WHERE target_kind = 'note' AND target_id = $1 AND subject_type = 'guild' AND subject_id = 'guild_north'`,
      [plan.id],
    );
    assert.deepEqual(stamps.rows[0], { created_by_name: "north-agent", updated_by_name: "operator" });
    await grantAccess(store, operator, { kind: "note", id: plan.id }, { type: "guild", id: "guild_north", mode: "write" });
    await assert.rejects(() => replaceAccess(store, operator, { kind: "note", id: own.id }, "all"), /subjects must be a list/);
    await assert.rejects(() => listAccess(store, operator, { kind: "note", id: "art_missing" }), /note not found/);

    // a subject in a guild the operator cannot see is neither listed nor dropped
    const blind = operatorActor({
      orgId: "org_home",
      actorId: "user_blind",
      actorName: "blind",
      hidden: { guildIds: ["guild_north"], agentIds: ["a_north", "a_north_late"] },
    });
    await assert.rejects(() => listAccess(store, blind, { kind: "note", id: plan.id }), /note not found/);
    await replaceAccess(store, blind, { kind: "note", id: handbook.id }, [{ type: "org", id: "org_home", mode: "write" }]);
    assert.deepEqual(await rowsOf(handbook.id), [["org", "org_home", "write"], ["guild", "guild_north", "write"]]);
    await assert.rejects(
      () => grantAccess(store, blind, { kind: "note", id: handbook.id }, { type: "guild", id: "guild_north", mode: "read" }),
      /unknown guild/,
    );

    // what a guild and an agent reach
    const notesOf = async (type: "guild" | "agent", id: string, guildId: string) =>
      (await reachOf(store, operator, { type, id, guildId })).notes
        .filter((note) => [plan.id, own.id, handbook.id].includes(note.id))
        .map((note) => [note.display_path, note.mode]);
    assert.deepEqual(await notesOf("agent", "a_north", "guild_north"), [
      [String(artifactView(own).display_path), "write"],
      [planPath, "write"],
      [handbookPath, "write"],
    ]);
    assert.deepEqual(await notesOf("guild", "guild_south", "guild_south"), [
      [planPath, "read"],
      [handbookPath, "write"],
    ]);
    const reached = (await reachOf(store, operator, { type: "agent", id: "a_north", guildId: "guild_north" })).notes;
    assert.deepEqual(
      reached.filter((note) => [own.id, handbook.id].includes(note.id)).map((note) => [note.owner_name, note.guild_id]),
      [["north-agent", "guild_north"], ["Home", null]],
    );

    // an agent reads no Memory revision, even of its own Memory
    const revision = revisionDisplayPath("org_home", "a_north", "20260101T000000-operator.md");
    assert.equal(await canReadDisplayPath(store, north, revision), false);
    assert.equal(await canReadDisplayPath(store, operator, revision), true);

    // a deleted note takes its access rows with it
    await deleteByDisplayPath(store, operator, planPath);
    const left = await database.pool.query(`SELECT count(*)::int AS n FROM artifact_access WHERE target_id = $1`, [plan.id]);
    assert.equal(left.rows[0]?.n, 0);
  });

  test("run tool calls record file create, update, and delete provenance", async () => {
    const now = new Date();
    await insertGuild(db,
      { guildId: "guild_provenance", name: "provenance", orgId: "org_home", about: "" },
      now,
    );
    await seedAgent("a_provenance", "guild_provenance", "provenance-agent", "provenance");
    assert.equal(
      (
        await listFileChanges(
          database.pool,
          "org_home",
          "org/org_home/agents/a_provenance/task.md",
        )
      )[0]?.operation,
      "create",
    );
    assert.equal(
      (
        await listFileChanges(
          database.pool,
          "org_home",
          "org/org_home/agents/a_provenance/memory.md",
        )
      )[0]?.operation,
      "create",
    );
    await insertRun(db,
      {
        runId: "r_provenance",
        agentId: "a_provenance",
        kind: "direct",
        configSnapshot: runSnapshot(CONFIG),
        systemContent: "system",
        taskContent: "task",
        opening: [],
        systemPromptHash: "system-hash",
        taskPromptHash: "task-hash",
        memoryPromptHash: "memory-hash",
      },
      now,
    );
    const ctx = createToolContext({
      run_id: "r_provenance",
      agent_id: "a_provenance",
      guild_id: "guild_provenance",
      sandbox: null,
      secrets: {},
      artifacts: toolArtifacts(store),
      artifact_actor: agentActor({
        orgId: "org_home",
        guildId: "guild_provenance",
        agentId: "a_provenance",
        agentName: "provenance-agent",
        runId: "r_provenance",
      }),
    });
    const call = async (id: string, name: string, args: Record<string, unknown>) =>
      invokeTool(ctx, { id, type: "function", function: { name, arguments: JSON.stringify(args) } }, {}, 32_768);

    const [, createdMetadata] = await call("call_create", "note_write", {
      level: "agent",
      key: "tracked.md",
      content: "one",
    });
    await call("call_update", "note_write", {
      level: "agent",
      key: "tracked.md",
      content: "two",
    });
    const displayPath = "org/org_home/agents/a_provenance/tracked.md";
    await call("call_delete", "note_delete", { path: displayPath });

    assert.equal(createdMetadata.tool_call_id, "call_create");
    const changes = await listFileChanges(database.pool, "org_home", displayPath);
    assert.deepEqual(
      changes.map((change) => change.operation),
      ["delete", "update", "create"],
    );
    assert.deepEqual(
      changes.map((change) => (change.tool as Record<string, unknown>).call_id),
      ["call_delete", "call_update", "call_create"],
    );
    assert.deepEqual(changes[0]?.run, {
      id: "r_provenance",
      agent_id: "a_provenance",
      guild_id: "guild_provenance",
      org_id: "org_home",
      kind: "direct",
      status: "active",
      schedule_id: null,
      created_at: changes[0]?.run?.created_at,
    });
    assert.match(String(changes[0]?.run?.created_at), /^\d{4}-\d{2}-\d{2}T/);

    // record tools carry the run and tool call too
    const operator = operatorActor({ orgId: "org_home", actorId: "user_operator", actorName: "operator" });
    const queue = await createCollection(store, operator, {
      name: "queue",
      purpose: "hand-off queue",
      columns: [{ name: "item", type: "text", description: "what to do", required: true }],
    });
    await grantAccess(store, operator, { kind: "collection", id: queue.id }, { type: "guild", id: "guild_provenance", mode: "write" });
    const [added] = await call("call_add", "record_add", { collection: "queue", body: { item: "first" } });
    assert.match(String(added.content), /"record":\{"id":1,"collection":"queue","item":"first"/);
    await call("call_patch", "record_update", { collection: "queue", id: 1, body: { item: "second" } });
    const [removed] = await call("call_remove", "record_remove", { collection: "queue", id: 1 });
    assert.match(String(removed.content), /"removed":1/);
    const recordChanges = await listFileChanges(database.pool, "org_home", "org/org_home/collections/queue/1");
    assert.deepEqual(
      recordChanges.map((change) => [change.operation, (change.tool as Record<string, unknown>).call_id]),
      [
        ["delete", "call_remove"],
        ["update", "call_patch"],
        ["create", "call_add"],
      ],
    );
  });

  test("notes sit directly under their owner and the memory archive is the operator's", async () => {
    const now = new Date();
    await insertGuild(db,
      { guildId: "guild_flat", name: "flat", orgId: "org_home", about: "" },
      now,
    );
    await seedAgent("a_flat", "guild_flat", "flat", "art-notes-flat");
    const alpha = agentActor({
      orgId: "org_home",
      guildId: "guild_flat",
      agentId: "a_flat",
      agentName: "flat",
    });
    const operator = operatorActor({
      orgId: "org_home",
      actorId: "user_operator",
      actorName: "operator",
      guildId: "guild_flat",
      agentId: "a_flat",
    });
    const { row: row } = await writeNote(store, alpha, { level: "agent", key: "exploration.md", content: "looked here\n" });
    assert.equal(row.path, "");
    assert.equal(artifactView(row).display_path, "org/org_home/agents/a_flat/exploration.md");
    await assert.rejects(
      () => writeNote(store, alpha, { level: "agent", key: "research/queries.md", content: "x" }),
      /notes have no folders/,
    );
    await assert.rejects(
      () => getByDisplayPath(store, alpha, "org/org_home/agents/a_flat/notes/exploration.md"),
      /artifact not found/,
    );

    await writeMemory(store, alpha, "a_flat", { content: "first\n", detail: "run r_1" });
    await writeMemory(store, alpha, "a_flat", { content: "second\n", detail: "run r_2" });
    const listed = await listOwnerNotes(store, operator, "agent", "a_flat");
    assert.deepEqual(
      listed.map((item) => [item.path, item.kind]),
      [["exploration.md", "note"]],
    );
    assert.deepEqual(await listRevisions(store, alpha, "a_flat"), []);
    const revisions = await listRevisions(store, operator, "a_flat");
    assert.equal(revisions.length, 2);
    await assert.rejects(() => getByDisplayPath(store, alpha, String(revisions[0]?.display_path)), /artifact not found/);
    const archived = await getByDisplayPath(store, operator, String(revisions[0]?.display_path));
    assert.equal(archived.revision?.content, "first\n");
    const found = await findNotes(store, alpha, { query: "first" });
    assert.deepEqual(found.notes, []);
  });

  test("an operator reads a Memory revision of its own organisation and is refused another organisation's", async () => {
    const now = new Date();
    await insertOrg(db, { orgId: "org_rev_other", name: "other", slug: "rev-other", userId: "user_operator" }, now);
    await insertGuild(db, { guildId: "guild_rev_other", name: "elsewhere", orgId: "org_rev_other", about: "" }, now);
    await addAgent(
      { db, notes: new NotesStore(tempDir("guilds-art-rev-other-notes-"), templatesRoot()), artifacts: store },
      { agent: { agentId: "a_rev_other", guildId: "guild_rev_other", name: "keeper", config: CONFIG }, task: "", placement: {} },
      systemActor("org_rev_other", { guildId: "guild_rev_other", agentId: "a_rev_other" }),
      now,
    );
    const keeper = agentActor({ orgId: "org_rev_other", guildId: "guild_rev_other", agentId: "a_rev_other", agentName: "keeper" });
    await writeMemory(store, keeper, "a_rev_other", { content: "kept elsewhere\n", detail: "run r_1" });
    await writeMemory(store, keeper, "a_rev_other", { content: "kept later\n", detail: "run r_2" });
    const ownOperator = operatorActor({ orgId: "org_rev_other", actorId: "user_operator", actorName: "operator" });
    const [revision] = await listRevisions(store, ownOperator, "a_rev_other");
    const revisionPath = String(revision?.display_path);

    const homeOperator = operatorActor({ orgId: "org_home", actorId: "user_operator", actorName: "operator" });
    await assert.rejects(() => getByDisplayPath(store, homeOperator, revisionPath), {
      name: "ArtifactError",
      message: "artifact is not in this organisation",
      status: 404,
    });
    const read = await getByDisplayPath(store, ownOperator, revisionPath);
    assert.equal(read.revision?.content, "kept elsewhere\n");
  });

  test("memory timeline keeps write order when two writes share a millisecond", async () => {
    const now = new Date();
    await insertGuild(db,
      { guildId: "guild_tl", name: "timeline", orgId: "org_home", about: "" },
      now,
    );
    await seedAgent("a_tl", "guild_tl", "timeline", "art-mem-tl");
    const operator = operatorActor({
      orgId: "org_home",
      actorId: "user_operator",
      actorName: "operator",
      guildId: "guild_tl",
      agentId: "a_tl",
    });
    const writer = agentActor({
      orgId: "org_home",
      guildId: "guild_tl",
      agentId: "a_tl",
      agentName: "timeline",
    });
    await writeMemory(store, operator, "a_tl", { content: "from operator\n", detail: "user operator" });
    await writeMemory(store, writer, "a_tl", { content: "from agent\n", detail: "agent timeline" });
    const live = await getMemoryRow(store, operator, "a_tl");
    const revisions = await listRevisions(store, operator, "a_tl");
    const entries = buildMemoryTimeline({ live: { content: live?.content_text ?? "" }, revisions });
    assert.equal(entries[0]?.actor.type, "agent");
    assert.equal(entries[0]?.content, "from agent\n");
    assert.equal(entries[1]?.actor.type, "user");
    assert.equal(entries[1]?.actor.name, "operator");
    assert.equal(entries[2]?.actor.type, "unknown");
    assert.ok(compareColumnTimestamps(String(revisions[0]?.replaced_at), String(revisions[1]?.replaced_at)) > 0);
  });

  test("task writes archive previous versions for restore", async () => {
    const now = new Date();
    await insertGuild(db,
      { guildId: "guild_taskver", name: "taskver", orgId: "org_home", about: "" },
      now,
    );
    const notes = new NotesStore(tempDir("guilds-art-notes-taskver-"), templatesRoot());
    await addAgent(
      { db, notes, artifacts: store },
      { agent: { agentId: "a_taskver", guildId: "guild_taskver", name: "taskver", config: CONFIG, focus: "seeded purpose" }, task: "seeded purpose", placement: {} },
      systemActor("org_home", { guildId: "guild_taskver", agentId: "a_taskver" }),
      now,
    );
    const operator = operatorActor({
      orgId: "org_home",
      actorId: "user_operator",
      actorName: "operator",
      guildId: "guild_taskver",
      agentId: "a_taskver",
    });
    const listedStart = await listOwnerNotes(store, operator, "agent", "a_taskver");
    assert.equal(listedStart.find((item) => item.path === "task.md"), undefined);
    const seeded = await getAgentTask(db, "org_home", "a_taskver");
    assert.equal(seeded?.version, 1);

    const first = await writeAgentTask(db, operator, "a_taskver", "first purpose\n");
    assert.equal(first.version, 2);
    const second = await writeAgentTask(db, operator, "a_taskver", "second purpose\n");
    assert.equal(second.version, 3);
    const unchanged = await writeAgentTask(db, operator, "a_taskver", "second purpose\n");
    assert.equal(unchanged.version, 3);

    const revisions = await listAgentTaskRevisions(db, "org_home", "a_taskver");
    assert.equal(revisions.length, 2);
    assert.equal(revisions[0]?.version, 2);
    assert.equal(revisions[0]?.content, "first purpose\n");
    assert.equal(revisions[1]?.version, 1);
    assert.equal(revisions[1]?.content, "seeded purpose\n");

    const restored = await writeAgentTask(db, operator, "a_taskver", revisions[0].content);
    assert.equal(restored.version, 4);
    assert.equal(restored.content_text, "first purpose\n");
    const afterRestore = await listAgentTaskRevisions(db, "org_home", "a_taskver");
    assert.equal(afterRestore.length, 3);
    assert.equal(afterRestore[0]?.version, 3);
    assert.equal(afterRestore[0]?.content, "second purpose\n");

    await assert.rejects(
      () =>
        writeAgentTask(db, operator, "a_taskver", "stale editor\n", 3),
      (error: unknown) => error instanceof Error && error.message === "version conflict",
    );
    const cas = await writeAgentTask(db, operator, "a_taskver", "cas purpose\n", 4);
    assert.equal(cas.version, 5);
  });
});
