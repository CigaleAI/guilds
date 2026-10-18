import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { ArtifactStore } from "../../src/artifacts/store.js";
import {
  agentActor,
  inlineTaskEmbeds,
  listFileChanges,
  operatorActor,
} from "../../src/artifacts/index.js";
import { DEFAULT_ARTIFACT_GRANTS } from "../../src/artifacts/types.js";
import { persistAgent } from "../../src/agents/persist.js";
import { connect, type Database } from "../../src/db/client.js";
import { Repositories } from "../../src/db/repositories.js";
import { NotesStore } from "../../src/notes/store.js";
import { createToolContext, invokeTool } from "../../src/toolbox/index.js";
import { templatesRoot } from "../helpers/fixtures.js";
import { tempDir } from "../helpers/env.js";
import { compareColumnTimestamps } from "../../src/db/codecs.js";
import { buildMemoryTimeline } from "../../src/memory/timeline.js";
import { createIsolatedDatabase, dropIsolatedDatabase, uniqueDbName } from "../helpers/postgres.js";

const dbName = uniqueDbName("agent_platform_artifacts");
let database: Database;
let store: ArtifactStore;
let repo: Repositories;

const CONFIG = {
  model: "openrouter/openai/gpt-5.6-luna",
  temperature: 1,
  max_tokens: 8192,
  max_steps: 30,
  max_tool_calls: 50,
  max_input_tokens: 100000,
  browser: false,
};

before(async () => {
  const databaseUrl = await createIsolatedDatabase(dbName);
  database = await connect(databaseUrl);
  repo = new Repositories(database.pool);
  store = new ArtifactStore(database.pool, templatesRoot());
});

after(async () => {
  await database.close();
  await dropIsolatedDatabase(dbName);
});

async function seedAgent(agentId: string, guildId: string, guildName: string, name: string, tag: string) {
  const now = new Date();
  const notes = new NotesStore(tempDir(`guilds-${tag}-notes-`), templatesRoot());
  await persistAgent(repo, notes, {
    agentId,
    guildId,
    guildName,
    orgSlug: "home",
    orgId: "org_home",
    name,
    config: CONFIG,
    now,
    artifacts: store,
  });
}

describe("artifact store", { concurrency: 1 }, () => {
  test("tenancy, grants, reserved paths, embeds, and collections", async () => {
    const now = new Date();
    await repo.insertGuild("guild_alpha", "alpha", now, "org_home", "");
    await repo.insertGuild("guild_beta", "beta", now, "org_home", "");
    await seedAgent("a_alpha", "guild_alpha", "alpha", "alpha", "art");
    await seedAgent("a_beta", "guild_beta", "beta", "beta", "art-beta");

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
      grants: DEFAULT_ARTIFACT_GRANTS,
    });
    const alphaNoOrg = agentActor({
      orgId: "org_home",
      guildId: "guild_alpha",
      agentId: "a_alpha",
      agentName: "alpha",
      grants: { ...DEFAULT_ARTIFACT_GRANTS, readOrg: false, writeOrg: false },
    });
    const beta = agentActor({
      orgId: "org_home",
      guildId: "guild_beta",
      agentId: "a_beta",
      agentName: "beta",
      grants: DEFAULT_ARTIFACT_GRANTS,
    });

    const orgNote = await store.writeNote(operator, {
      level: "org",
      key: "schema.md",
      content: "org schema\n",
    });
    const orgPath = String(store.view(orgNote).display_path);
    const embeddable = await store.listEmbeddableNotes(operator);
    const preview = embeddable.find((item) => item.display_path === orgPath);
    assert.equal(preview?.content, "org schema\n");
    assert.equal(preview?.kind, "note");

    await store.writeNote(alpha, {
      level: "agent",
      key: "secret.md",
      content: "alpha secret\n",
    });
    await store.writeNote(alpha, {
      level: "guild",
      key: "handoff.md",
      content: "guild note\n",
    });

    await assert.rejects(() => store.getByDisplayPath(alphaNoOrg, orgPath), /artifact not found/);
    const operatorSeesDenied = await inlineTaskEmbeds(store, operator, `Follow ![[${orgPath}]]\n`);
    assert.match(operatorSeesDenied, /org schema/);
    const loadedOrg = await store.getByDisplayPath(alpha, orgPath);
    assert.equal(loadedOrg.row?.content_text, "org schema\n");

    await assert.rejects(
      () => store.getByDisplayPath(beta, "org/org_home/agents/a_alpha/secret.md"),
      /artifact not found/,
    );
    await assert.rejects(
      () => store.getByDisplayPath(beta, "org/org_home/guilds/guild_alpha/handoff.md"),
      /artifact not found/,
    );

    await assert.rejects(
      () =>
        store.writeNote(alpha, {
          level: "org",
          key: "published.md",
          content: "nope",
        }),
      /write not allowed/,
    );
    await assert.rejects(
      () =>
        store.writeNote(alpha, {
          level: "agent",
          key: "task.md",
          content: "stolen",
        }),
      /reserved/,
    );
    await assert.rejects(
      () =>
        store.writeNote(operator, {
          level: "org",
          key: "collections/x.md",
          content: "nope",
        }),
      /notes have no folders/,
    );

    await repo.writeAgentTask(
      operator,
      "a_alpha",
      `Follow ![[${orgPath}]]\n\nNested stays in the note.\n`,
    );
    const inlined = await inlineTaskEmbeds(
      store,
      operator,
      (await repo.getAgentTask(operator.orgId, "a_alpha"))?.content_text ?? "",
    );
    assert.match(inlined, /org schema/);
    assert.match(inlined, /<schema path="org\/org_home\/schema\.md" level="org">/);

    const asAgent = await inlineTaskEmbeds(store, alpha, `Follow ![[${orgPath}]]\n`);
    assert.match(asAgent, /org schema/);

    await store.writeNote(operator, {
      level: "org",
      key: "nested.md",
      content: `See ![[${orgPath}]]\n`,
    });
    const nested = await inlineTaskEmbeds(store, operator, `Use ![[org/org_home/nested.md]]\n`);
    assert.match(nested, /<nested path="org\/org_home\/nested\.md" level="org">/);
    assert.match(nested, /<schema path="org\/org_home\/schema\.md" level="org">/);
    assert.match(nested, /org schema/);
    assert.ok(!nested.includes("See ![["));

    // Collections are managed by the operator at the organisation.
    await assert.rejects(
      () => store.createCollection(alpha, { name: "papers", purpose: "reading list" }),
      (error: Error & { status?: number }) => /managed by the operator/.test(error.message) && error.status === 403,
    );
    await assert.rejects(() => store.addRecord(alpha, { collection: "missing", body: {} }), /unknown collection missing/);
    await assert.rejects(
      () => store.createCollection(operator, { name: "papers", purpose: "reading list", columns: [{ name: "id", type: "text", description: "x" }] }),
      /column "id": name is reserved/,
    );
    const papers = await store.createCollection(operator, {
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
    await assert.rejects(() => store.createCollection(operator, { name: "papers", purpose: "again" }), /already exists/);

    // Nobody sees a collection until it is granted.
    assert.equal(await store.describeCollection(alpha, "papers"), null);
    assert.deepEqual(await store.catalog(alpha), []);
    await assert.rejects(() => store.addRecord(alpha, { collection: "papers", body: { title: "Bees" } }), /unknown collection papers/);
    await assert.rejects(() => store.listRecords(alpha, { collection: "papers" }), /unknown collection papers/);

    await store.setAccess(operator, { collectionId: papers.id, subjectType: "guild", subjectId: "guild_alpha", mode: "read" });
    assert.equal((await store.describeCollection(alpha, "papers"))?.access, "read");
    await assert.rejects(
      () => store.addRecord(alpha, { collection: "papers", body: { title: "Bees" } }),
      (error: Error & { status?: number }) => error.message === "no write access to papers" && error.status === 403,
    );
    assert.deepEqual(await store.listRecords(alpha, { collection: "papers" }), { total: 0, records: [], columns: papers.columns });
    const catalog = await store.catalog(alpha);
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
    assert.equal(await store.describeCollection(beta, "papers"), null);

    // An agent's own grant reaches an organisation table its guild was never given, and the catalog lists it.
    await store.setAccess(operator, { collectionId: papers.id, subjectType: "agent", subjectId: "a_beta", mode: "read" });
    assert.equal((await store.describeCollection(beta, "papers"))?.access, "read");
    assert.deepEqual((await store.catalog(beta)).map((item) => [item.name, item.access]), [["papers", "read"]]);
    await store.setAccess(operator, { collectionId: papers.id, subjectType: "agent", subjectId: "a_beta", mode: null });

    // An agent grant raises the guild's mode; the operator sees both.
    await store.setAccess(operator, { collectionId: papers.id, subjectType: "agent", subjectId: "a_alpha", mode: "write" });
    assert.equal((await store.describeCollection(alpha, "papers"))?.access, "write");
    const access = await store.listAccess(operator, papers.id);
    assert.deepEqual(access.guilds, [{ id: "guild_alpha", name: "alpha", mode: "read" }]);
    assert.deepEqual(access.agents, [
      { id: "a_alpha", name: "alpha", guild_id: "guild_alpha", guild_name: "alpha", guild_mode: "read", agent_mode: "write", effective: "write" },
    ]);
    assert.deepEqual(await store.accessForGuild(operator, "guild_beta"), [
      { collection_id: papers.id, name: "papers", purpose: "reading list", scope: "org", mode: null },
    ]);
    assert.deepEqual(await store.accessForAgent(operator, "a_alpha", "guild_alpha"), [
      { collection_id: papers.id, name: "papers", purpose: "reading list", scope: "org", guild_mode: "read", agent_mode: "write", effective: "write" },
    ]);
    // the agent's own row overrides its guild's base mode, and `none` keeps it out
    await store.setAccess(operator, { collectionId: papers.id, subjectType: "agent", subjectId: "a_alpha", mode: "none" });
    assert.equal(await store.describeCollection(alpha, "papers"), null);
    assert.deepEqual(await store.catalog(alpha), []);
    await assert.rejects(() => store.listRecords(alpha, { collection: "papers" }), /unknown collection papers/);
    assert.deepEqual(await store.accessForAgent(operator, "a_alpha", "guild_alpha"), [
      { collection_id: papers.id, name: "papers", purpose: "reading list", scope: "org", guild_mode: "read", agent_mode: "none", effective: null },
    ]);
    assert.deepEqual((await store.listAccess(operator, papers.id)).agents, [
      { id: "a_alpha", name: "alpha", guild_id: "guild_alpha", guild_name: "alpha", guild_mode: "read", agent_mode: "none", effective: null },
    ]);
    await assert.rejects(
      () => store.setAccess(operator, { collectionId: papers.id, subjectType: "guild", subjectId: "guild_alpha", mode: "none" }),
      /mode must be read, write, or null/,
    );
    await store.setAccess(operator, { collectionId: papers.id, subjectType: "agent", subjectId: "a_alpha", mode: "write" });
    await assert.rejects(
      () => store.setAccess(operator, { collectionId: papers.id, subjectType: "agent", subjectId: "a_nobody", mode: "read" }),
      /unknown agent/,
    );
    await assert.rejects(
      () => store.setAccess(operator, { collectionId: papers.id, subjectType: "team", subjectId: "guild_alpha", mode: "read" }),
      /subject_type must be guild or agent/,
    );
    await assert.rejects(
      () => store.setAccess(alpha, { collectionId: papers.id, subjectType: "guild", subjectId: "guild_alpha", mode: "read" }),
      /managed by the operator/,
    );

    const added = await store.addRecord(alpha, { collection: "papers", body: { title: "Bees", n: 1, tags: "insects" } });
    assert.equal(added.merged, null);
    assert.equal(added.record.id, 1);
    assert.equal(added.record.collection, "papers");
    assert.equal(added.record.title, "Bees");
    assert.equal(added.record.updated_by, "alpha");
    assert.ok(!("display_path" in added.record));
    assert.match(String(added.record.created_at), /^\d{4}-\d{2}-\d{2}T/);
    assert.equal(await store.getRecord(alpha, "papers", 1).then((record) => record.n), 1);
    await assert.rejects(() => store.getRecord(beta, "papers", 1), /unknown collection papers/);
    const loaded = await store.getByDisplayPath(operator, "org/org_home/collections/papers/1");
    assert.equal(loaded.row?.kind, "object");
    assert.equal(store.view(loaded.row!).display_path, "org/org_home/collections/papers/1");
    assert.equal((await store.listCollections(operator, { counts: true }))[0]?.count, 1);

    // Column changes reshape the live records.
    const reshaped = await store.updateCollection(operator, papers.id, {
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
    const moved = await store.getRecord(operator, "papers", 1);
    assert.equal(moved.citations, 1);
    assert.equal("n" in moved, false);
    assert.equal("tags" in moved, false);
    // the renamed unique column now dedupes on title
    const merged = await store.addRecord(alpha, { collection: "papers", body: { title: " bees ", status: "read" } });
    assert.equal(merged.merged, 1);
    assert.equal(merged.record.status, "read");
    assert.equal(merged.record.citations, 1);
    await assert.rejects(
      () => store.addRecord(alpha, { collection: "papers", body: { title: "Ants", status: "skimmed" } }),
      /record rejected\n- column "status": expected one of unread, read; got "skimmed"/,
    );
    await store.addRecord(alpha, { collection: "papers", body: { title: "Ants" } });
    // a null value never repeats; once both records carry the same count the column cannot become unique
    await store.updateRecord(alpha, { collection: "papers", id: 2, body: { citations: 1 } });
    await assert.rejects(
      () =>
        store.updateCollection(operator, papers.id, {
          columns: [
            { name: "title", type: "text", description: "paper title", required: true },
            { name: "citations", type: "number", description: "citation count", unique: true },
            { name: "status", type: "text", description: "review state", values: ["unread", "read"] },
          ],
        }),
      /column "citations" cannot be unique while live records repeat: 1/,
    );
    await assert.rejects(() => store.updateCollection(operator, papers.id, { name: "Papers!" }), /collection name must match/);

    // Deleting a collection removes its records and grants.
    await store.deleteCollection(operator, papers.id);
    assert.equal(await store.describeCollection(alpha, "papers"), null);
    await assert.rejects(() => store.getCollection(operator, papers.id), /unknown collection/);
    assert.deepEqual(await store.accessForGuild(operator, "guild_alpha"), []);
    const gone = await database.pool.query(`SELECT count(*)::int AS n FROM artifacts WHERE collection_id = $1 AND deleted_at IS NULL`, [papers.id]);
    assert.equal(gone.rows[0]?.n, 0);
    const grants = await database.pool.query(`SELECT count(*)::int AS n FROM collection_access WHERE collection_id = $1`, [papers.id]);
    assert.equal(grants.rows[0]?.n, 0);
    // the name is free again
    const again = await store.createCollection(operator, { name: "papers", purpose: "fresh" });
    assert.notEqual(again.id, papers.id);
    assert.equal((await store.addRecord(operator, { collection: "papers", body: {} })).record.id, 1);
  });

  test("records: validation, ids, identity merge, where, since, order, and search", async () => {
    const now = new Date();
    await repo.insertGuild("guild_search", "search", now, "org_home", "");
    await seedAgent("a_search", "guild_search", "search", "searcher", "search");
    const searcher = agentActor({
      orgId: "org_home",
      guildId: "guild_search",
      agentId: "a_search",
      agentName: "searcher",
      grants: DEFAULT_ARTIFACT_GRANTS,
    });
    const operator = operatorActor({
      orgId: "org_home",
      actorId: "user_operator",
      actorName: "operator",
      guildId: "guild_search",
      agentId: "a_search",
    });
    const packets = await store.createCollection(operator, {
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
    await store.setAccess(operator, { collectionId: packets.id, subjectType: "guild", subjectId: "guild_search", mode: "write" });

    // every problem at once, nothing written
    await assert.rejects(
      () => store.addRecord(searcher, { collection: "packets", body: { chain: 5, status: "new", novelty: "1", seen_at: "yesterday", extra: 1 } }),
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
    assert.equal((await store.listRecords(searcher, { collection: "packets" })).total, 0);

    const add = (body: Record<string, unknown>) => store.addRecord(searcher, { collection: "packets", body });
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
    assert.equal((await store.listRecords(searcher, { collection: "packets" })).total, 3);

    // update: only the patched columns are validated, null clears, ids are never invented
    const patched = await store.updateRecord(searcher, { collection: "packets", id: "2", body: { handled: true, novelty: null } });
    assert.equal(patched.record.handled, true);
    assert.equal("novelty" in patched.record, false);
    assert.deepEqual(patched.warnings, []);
    await assert.rejects(
      () => store.updateRecord(searcher, { collection: "packets", id: 2, body: { project: null } }),
      /column "project": required; cannot be cleared/,
    );
    await assert.rejects(
      () => store.updateRecord(searcher, { collection: "packets", id: 2, body: { project: "AntHood" } }),
      (error: Error & { status?: number }) => error.status === 409 && /another record already holds that project: record 3 already holds that value/.test(error.message),
    );
    await assert.rejects(() => store.updateRecord(searcher, { collection: "packets", id: 99, body: { handled: true } }), /record 99 not found/);
    await assert.rejects(() => store.updateRecord(searcher, { collection: "packets", id: "two", body: {} }), /id must be a positive integer/);

    // a column change leaves old values in place; the next update reports them without blocking
    await store.updateCollection(operator, packets.id, {
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
    const warned = await store.updateRecord(searcher, { collection: "packets", id: 1, body: { chain: "Zcash mainnet" } });
    assert.deepEqual(warned.warnings, ['column "status": expected one of open, closed; got "blocked"', 'column "owner": required']);
    await store.updateRecord(searcher, { collection: "packets", id: 1, body: { status: "closed", owner: "desk" } });
    await store.updateRecord(searcher, { collection: "packets", id: 2, body: { owner: "desk" } });
    await store.updateRecord(searcher, { collection: "packets", id: 3, body: { owner: "scout" } });

    const list = async (args: Record<string, unknown>) =>
      (await store.listRecords(searcher, { collection: "packets", ...args })).records.map((row) => row.id);

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
    const paged = await store.listRecords(searcher, { collection: "packets", limit: 2, offset: 1 });
    assert.equal(paged.total, 3);
    assert.deepEqual(paged.records.map((row) => row.id), [2, 3]);

    // since: only records changed at or after the cursor, oldest change first
    const all = (await store.listRecords(searcher, { collection: "packets", order: "updated_at" })).records;
    const stamps = all.map((row) => String(row.updated_at));
    assert.ok(stamps.every((stamp) => /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/.test(stamp)), stamps.join(","));
    assert.deepEqual(await list({ since: stamps[stamps.length - 1] }), [3]);
    assert.deepEqual(await list({ since: "2000-01-01T00:00:00Z" }), all.map((row) => row.id));
    assert.deepEqual(await list({ since: "2999-01-01T00:00:00Z" }), []);
    await assert.rejects(() => list({ since: "last week" }), /ISO 8601/);

    // search: whole words, OR, phrase, exclusion, single-token substring; never fuzzy
    const search = async (args: { collection?: string; query: string; where?: unknown }) =>
      (await store.searchRecords(searcher, args)).records.map((row) => `${row.collection}/${row.id}`);
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
    await assert.rejects(() => store.searchRecords(searcher, { query: "  " }), /query is required/);

    // facts for the empty-result hint
    const facts = await store.collectionFacts(searcher, "packets");
    assert.equal(facts?.count, 3);
    assert.equal(facts?.newest_updated_at, stamps[stamps.length - 1]);
    assert.deepEqual(facts?.columns.map((column) => column.name), ["project", "handled", "chain", "status", "novelty", "seen_at", "owner"]);
    assert.equal(await store.collectionFacts(searcher, "nope"), null);
    const outsider = agentActor({
      orgId: "org_home",
      guildId: "guild_alpha",
      agentId: "a_alpha",
      agentName: "alpha",
      grants: DEFAULT_ARTIFACT_GRANTS,
    });
    assert.equal(await store.collectionFacts(outsider, "packets"), null);
    assert.deepEqual(await search({ query: "Solana" }).then(() => store.searchRecords(outsider, { query: "Solana" })), { records: [] });

    // remove: soft, ids are never reused, provenance is recorded
    assert.equal(await store.removeRecord(searcher, { collection: "packets", id: 3 }), 3);
    await assert.rejects(() => store.removeRecord(searcher, { collection: "packets", id: 3 }), /record 3 not found/);
    assert.deepEqual(await list({}), [1, 2]);
    const next = await add({ project: "AntHood", handled: false, owner: "scout" });
    assert.equal(next.record.id, 4);
    const tombstone = await store.getByDisplayPath(operator, "org/org_home/collections/packets/3");
    assert.equal(tombstone.tombstone, true);
    const changes = await listFileChanges(database.pool, "org_home", "org/org_home/collections/packets/3");
    assert.deepEqual(changes.map((change) => change.operation), ["delete", "update", "create"]);
    const exported = await store.exportRecords(operator, packets.id);
    assert.deepEqual(exported.records.map((row) => row.id), [1, 2, 4]);
    assert.equal(exported.name, "packets");
  });

  test("operator can clear every live record without deleting the collection", async () => {
    const now = new Date();
    await repo.insertGuild("guild_scratch", "scratch", now, "org_home", "");
    await seedAgent("a_scratch", "guild_scratch", "scratch", "scratcher", "scratch");
    const writer = agentActor({
      orgId: "org_home",
      guildId: "guild_scratch",
      agentId: "a_scratch",
      agentName: "scratcher",
      grants: DEFAULT_ARTIFACT_GRANTS,
    });
    const operator = operatorActor({
      orgId: "org_home",
      actorId: "user_operator",
      actorName: "operator",
      guildId: "guild_scratch",
      agentId: "a_scratch",
    });
    const scratch = await store.createCollection(operator, {
      name: "scratch",
      purpose: "throwaway rows",
      columns: [{ name: "title", type: "text", description: "row title", required: true, unique: true }],
    });
    await store.setAccess(operator, { collectionId: scratch.id, subjectType: "guild", subjectId: "guild_scratch", mode: "write" });
    await store.addRecord(writer, { collection: "scratch", body: { title: "one" } });
    await store.addRecord(writer, { collection: "scratch", body: { title: "two" } });
    await store.addRecord(writer, { collection: "scratch", body: { title: "three" } });

    await assert.rejects(() => store.clearRecords(writer, scratch.id), /managed by the operator/);
    assert.equal(await store.clearRecords(operator, scratch.id), 3);
    assert.deepEqual((await store.listRecords(writer, { collection: "scratch" })).records, []);
    assert.equal((await store.getCollection(operator, scratch.id)).count, 0);
    const grants = await store.accessForGuild(operator, "guild_scratch");
    assert.equal(grants.some((row) => row.collection_id === scratch.id && row.mode === "write"), true);
    const again = await store.addRecord(writer, { collection: "scratch", body: { title: "one" } });
    assert.equal(again.record.id, 4);
    assert.equal(again.merged, null);
    assert.equal(await store.clearRecords(operator, scratch.id), 1);
    assert.equal(await store.clearRecords(operator, scratch.id), 0);
    await assert.rejects(() => store.clearRecords(operator, "col_missing"), /unknown collection/);
  });

  test("an array column stores a list of text and where matches an item like text", async () => {
    const now = new Date();
    await repo.insertGuild("guild_tags", "tags", now, "org_home", "");
    await seedAgent("a_tags", "guild_tags", "tags", "tagger", "tags");
    const tagger = agentActor({
      orgId: "org_home",
      guildId: "guild_tags",
      agentId: "a_tags",
      agentName: "tagger",
      grants: DEFAULT_ARTIFACT_GRANTS,
    });
    const operator = operatorActor({
      orgId: "org_home",
      actorId: "user_operator",
      actorName: "operator",
      guildId: "guild_tags",
      agentId: "a_tags",
    });
    const notes = await store.createCollection(operator, {
      name: "tagged-notes",
      purpose: "notes with labels",
      columns: [
        { name: "title", type: "text", description: "note title", required: true },
        { name: "tags", type: "array", description: "labels" },
        { name: "kind", type: "array", description: "closed labels", values: ["work", "home"] },
      ],
    });
    await store.setAccess(operator, { collectionId: notes.id, subjectType: "guild", subjectId: "guild_tags", mode: "write" });

    await assert.rejects(
      () => store.addRecord(tagger, { collection: "tagged-notes", body: { title: "one", tags: "solo", kind: ["play"] } }),
      /column "tags": expected a list of text; got "solo"[\s\S]*column "kind": item 1: expected one of work, home; got "play"/,
    );

    const first = await store.addRecord(tagger, {
      collection: "tagged-notes",
      body: { title: "alpha", tags: ["crm", "warm", "solana"], kind: ["work"] },
    });
    await store.addRecord(tagger, {
      collection: "tagged-notes",
      body: { title: "beta", tags: ["crm"], kind: ["home"] },
    });
    const empty = await store.addRecord(tagger, { collection: "tagged-notes", body: { title: "gamma", tags: [] } });
    await store.addRecord(tagger, { collection: "tagged-notes", body: { title: "delta" } });
    assert.deepEqual(first.record.tags, ["crm", "warm", "solana"]);
    assert.deepEqual(first.record.kind, ["work"]);
    assert.deepEqual(empty.record.tags, []);

    const list = async (where: Record<string, unknown>) =>
      (await store.listRecords(tagger, { collection: "tagged-notes", where })).records.map((row) => row.id);
    assert.deepEqual(await list({ tags: "crm" }), [1, 2]);
    assert.deepEqual(await list({ tags: "cr" }), [1, 2]);
    assert.deepEqual(await list({ tags: "warm" }), [1]);
    assert.deepEqual(await list({ tags: "solanna" }), [1]);
    assert.deepEqual(await list({ kind: "home" }), [2]);
    assert.deepEqual(await list({ tags: null }), [4]);
    await assert.rejects(() => list({ kind: "play" }), /where\.kind: expected one of work, home/);
    await assert.rejects(
      () => store.listRecords(tagger, { collection: "tagged-notes", order: { column: "tags" } }),
      /order\.column cannot be an array column/,
    );

    const patched = await store.updateRecord(tagger, { collection: "tagged-notes", id: 1, body: { tags: ["warm"] } });
    assert.deepEqual(patched.record.tags, ["warm"]);
    assert.deepEqual(await list({ tags: "crm" }), [2]);
  });

  test("a guild's own table: members write it, nobody else reaches it, it moves and dies with the guild", async () => {
    const now = new Date();
    await repo.insertGuild("guild_own", "own", now, "org_home", "");
    await repo.insertGuild("guild_other", "other", now, "org_home", "");
    await seedAgent("a_own", "guild_own", "own", "owner-agent", "own");
    await seedAgent("a_other", "guild_other", "other", "other-agent", "other");
    const operator = operatorActor({ orgId: "org_home", actorId: "user_operator", actorName: "operator" });
    const member = agentActor({ orgId: "org_home", guildId: "guild_own", agentId: "a_own", agentName: "owner-agent", grants: DEFAULT_ARTIFACT_GRANTS });
    const outsider = agentActor({ orgId: "org_home", guildId: "guild_other", agentId: "a_other", agentName: "other-agent", grants: DEFAULT_ARTIFACT_GRANTS });

    await assert.rejects(
      () => store.createCollection(operator, { name: "own-notes", purpose: "the guild's scratch table", guildId: "guild_nope" }),
      /unknown guild/,
    );
    const own = await store.createCollection(operator, {
      name: "own-notes",
      purpose: "the guild's scratch table",
      columns: [{ name: "note", type: "text", description: "what was noted", required: true }],
      guildId: "guild_own",
    });
    assert.equal(own.scope, "guild");
    assert.deepEqual(own.guild, { id: "guild_own", name: "own" });

    // members write without any grant; other guilds cannot see it; grants are refused
    const added = await store.addRecord(member, { collection: "own-notes", body: { note: "first" } });
    assert.equal(added.record.id, 1);
    assert.equal((await store.describeCollection(member, "own-notes"))?.access, "write");
    assert.equal(await store.describeCollection(outsider, "own-notes"), null);
    await assert.rejects(() => store.listRecords(outsider, { collection: "own-notes" }), /unknown collection own-notes/);
    assert.deepEqual((await store.searchRecords(outsider, { query: "first" })).records, []);
    assert.deepEqual((await store.searchRecords(member, { query: "first" })).records.map((row) => row.id), [1]);
    await assert.rejects(
      () => store.setAccess(operator, { collectionId: own.id, subjectType: "guild", subjectId: "guild_other", mode: "read" }),
      (error: Error & { status?: number }) => error.status === 422 && /belongs to own/.test(error.message),
    );
    await assert.rejects(
      () => store.setAccess(operator, { collectionId: own.id, subjectType: "agent", subjectId: "a_other", mode: "read" }),
      (error: Error & { status?: number }) => error.status === 422 && /only an agent of that guild/.test(error.message),
    );
    assert.deepEqual(await store.listAccess(operator, own.id), {
      guilds: [{ id: "guild_own", name: "own", mode: "write" }],
      agents: [
        { id: "a_own", name: "owner-agent", guild_id: "guild_own", guild_name: "own", guild_mode: "write", agent_mode: null, effective: "write" },
      ],
    });
    assert.deepEqual(
      (await store.catalog(member)).map((item) => [item.name, item.scope, item.access]),
      [["own-notes", "guild", "write"]],
    );
    assert.deepEqual(await store.catalog(outsider), []);

    // an override keeps one member out of its own guild's table
    await store.setAccess(operator, { collectionId: own.id, subjectType: "agent", subjectId: "a_own", mode: "none" });
    assert.equal(await store.describeCollection(member, "own-notes"), null);
    await assert.rejects(() => store.listRecords(member, { collection: "own-notes" }), /unknown collection own-notes/);
    assert.deepEqual((await store.searchRecords(member, { query: "first" })).records, []);
    assert.deepEqual(await store.catalog(member), []);
    assert.equal((await store.listAccess(operator, own.id)).agents[0]?.effective, null);
    await store.setAccess(operator, { collectionId: own.id, subjectType: "agent", subjectId: "a_own", mode: "read" });
    assert.equal((await store.describeCollection(member, "own-notes"))?.access, "read");
    await assert.rejects(() => store.addRecord(member, { collection: "own-notes", body: { note: "x" } }), /no write access to own-notes/);
    await store.setAccess(operator, { collectionId: own.id, subjectType: "agent", subjectId: "a_own", mode: null });
    assert.equal((await store.describeCollection(member, "own-notes"))?.access, "write");

    // the guild's own table sits beside the organisation tables it is granted
    const shared = await store.createCollection(operator, { name: "shared-notes", purpose: "an organisation table" });
    await store.setAccess(operator, { collectionId: shared.id, subjectType: "guild", subjectId: "guild_own", mode: "read" });
    const ours = (rows: Array<{ name: string }>) => rows.filter((row) => row.name === "own-notes" || row.name === "shared-notes");
    assert.deepEqual(ours(await store.accessForGuild(operator, "guild_own")), [
      { collection_id: own.id, name: "own-notes", purpose: "the guild's scratch table", scope: "guild", mode: "write" },
      { collection_id: shared.id, name: "shared-notes", purpose: "an organisation table", scope: "org", mode: "read" },
    ]);
    assert.deepEqual(
      ours(await store.accessForGuild(operator, "guild_other")).map((row) => row.name),
      ["shared-notes"],
    );
    assert.deepEqual(ours(await store.accessForAgent(operator, "a_own", "guild_own")), [
      { collection_id: own.id, name: "own-notes", purpose: "the guild's scratch table", scope: "guild", guild_mode: "write", agent_mode: null, effective: "write" },
      { collection_id: shared.id, name: "shared-notes", purpose: "an organisation table", scope: "org", guild_mode: "read", agent_mode: null, effective: "read" },
    ]);

    // moving to the organisation keeps the guild's reach as a write grant; moving to a guild drops grants
    const promoted = await store.updateCollection(operator, own.id, { guildId: null });
    assert.equal(promoted.scope, "org");
    assert.equal(promoted.guild, null);
    assert.deepEqual((await store.listAccess(operator, own.id)).guilds, [{ id: "guild_own", name: "own", mode: "write" }]);
    assert.equal((await store.describeCollection(member, "own-notes"))?.access, "write");
    await store.setAccess(operator, { collectionId: own.id, subjectType: "guild", subjectId: "guild_other", mode: "read" });
    assert.equal((await store.describeCollection(outsider, "own-notes"))?.access, "read");
    const restricted = await store.updateCollection(operator, own.id, { guildId: "guild_other" });
    assert.equal(restricted.scope, "guild");
    assert.equal(restricted.guild?.id, "guild_other");
    assert.equal(await store.describeCollection(member, "own-notes"), null);
    assert.equal((await store.describeCollection(outsider, "own-notes"))?.access, "write");
    const grants = await database.pool.query(`SELECT count(*)::int AS n FROM collection_access WHERE collection_id = $1`, [own.id]);
    assert.equal(grants.rows[0]?.n, 0);

    // deleting a guild soft-deletes its own tables and their records
    await repo.deleteGuild("guild_other");
    await assert.rejects(() => store.getCollection(operator, own.id), /unknown collection/);
    const records = await database.pool.query(
      `SELECT count(*)::int AS n FROM artifacts WHERE collection_id = $1 AND deleted_at IS NULL`,
      [own.id],
    );
    assert.equal(records.rows[0]?.n, 0);
    assert.equal((await store.getCollection(operator, shared.id)).name, "shared-notes");
  });

  test("run tool calls record file create, update, and delete provenance", async () => {
    const now = new Date();
    await repo.insertGuild("guild_provenance", "provenance", now, "org_home", "");
    await seedAgent("a_provenance", "guild_provenance", "provenance", "provenance-agent", "provenance");
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
    await repo.insertRun(
      "r_provenance",
      "a_provenance",
      "direct",
      CONFIG,
      "system",
      "task",
      [],
      now,
      {
        systemPromptHash: "system-hash",
        taskPromptHash: "task-hash",
        memoryPromptHash: "memory-hash",
      },
    );
    const ctx = createToolContext({
      run_id: "r_provenance",
      agent_id: "a_provenance",
      guild_id: "guild_provenance",
      sandbox: null,
      secrets: {},
      artifacts: store,
      artifact_actor: agentActor({
        orgId: "org_home",
        guildId: "guild_provenance",
        agentId: "a_provenance",
        agentName: "provenance-agent",
        grants: DEFAULT_ARTIFACT_GRANTS,
        runId: "r_provenance",
      }),
    });
    const call = async (id: string, name: string, args: Record<string, unknown>) =>
      invokeTool(ctx, { id, function: { name, arguments: args } }, {}, 32_768);

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
    const queue = await store.createCollection(operator, {
      name: "queue",
      purpose: "hand-off queue",
      columns: [{ name: "item", type: "text", description: "what to do", required: true }],
    });
    await store.setAccess(operator, { collectionId: queue.id, subjectType: "guild", subjectId: "guild_provenance", mode: "write" });
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
    await repo.insertGuild("guild_flat", "flat", now, "org_home", "");
    await seedAgent("a_flat", "guild_flat", "flat", "flat", "art-notes-flat");
    const alpha = agentActor({
      orgId: "org_home",
      guildId: "guild_flat",
      agentId: "a_flat",
      agentName: "flat",
      grants: DEFAULT_ARTIFACT_GRANTS,
    });
    const operator = operatorActor({
      orgId: "org_home",
      actorId: "user_operator",
      actorName: "operator",
      guildId: "guild_flat",
      agentId: "a_flat",
    });
    const row = await store.writeNote(alpha, { level: "agent", key: "exploration.md", content: "looked here\n" });
    assert.equal(row.path, "");
    assert.equal(store.view(row).display_path, "org/org_home/agents/a_flat/exploration.md");
    await assert.rejects(
      () => store.writeNote(alpha, { level: "agent", key: "research/queries.md", content: "x" }),
      /notes have no folders/,
    );
    await assert.rejects(
      () => store.getByDisplayPath(alpha, "org/org_home/agents/a_flat/notes/exploration.md"),
      /artifact not found/,
    );

    await store.writeMemory(alpha, "a_flat", "first\n", "run r_1");
    await store.writeMemory(alpha, "a_flat", "second\n", "run r_2");
    const listed = await store.listOwnerNotes(operator, "agent", "a_flat");
    assert.deepEqual(
      listed.map((item) => [item.path, item.kind]),
      [["exploration.md", "note"]],
    );
    assert.deepEqual(await store.listRevisions(alpha, "a_flat"), []);
    const revisions = await store.listRevisions(operator, "a_flat");
    assert.equal(revisions.length, 2);
    await assert.rejects(() => store.getByDisplayPath(alpha, String(revisions[0]?.display_path)), /artifact not found/);
    const archived = await store.getByDisplayPath(operator, String(revisions[0]?.display_path));
    assert.equal(archived.revision?.content, "first\n");
    const found = await store.find(alpha, { query: "first" });
    assert.deepEqual(found.notes, []);
  });

  test("memory timeline keeps write order when two writes share a millisecond", async () => {
    const now = new Date();
    await repo.insertGuild("guild_tl", "timeline", now, "org_home", "");
    await seedAgent("a_tl", "guild_tl", "timeline", "timeline", "art-mem-tl");
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
      grants: DEFAULT_ARTIFACT_GRANTS,
    });
    await store.writeMemory(operator, "a_tl", "from operator\n", "user operator");
    await store.writeMemory(writer, "a_tl", "from agent\n", "agent timeline");
    const live = await store.getMemoryRow(operator, "a_tl");
    const revisions = await store.listRevisions(operator, "a_tl");
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
    await repo.insertGuild("guild_taskver", "taskver", now, "org_home", "");
    const notes = new NotesStore(tempDir("guilds-art-notes-taskver-"), templatesRoot());
    await persistAgent(repo, notes, {
      agentId: "a_taskver",
      guildId: "guild_taskver",
      guildName: "taskver",
      orgSlug: "home",
      orgId: "org_home",
      name: "taskver",
      focus: "seeded purpose",
      config: CONFIG,
      now,
      artifacts: store,
    });
    const operator = operatorActor({
      orgId: "org_home",
      actorId: "user_operator",
      actorName: "operator",
      guildId: "guild_taskver",
      agentId: "a_taskver",
    });
    const listedStart = await store.listOwnerNotes(operator, "agent", "a_taskver");
    assert.equal(listedStart.find((item) => item.path === "task.md"), undefined);
    const seeded = await repo.getAgentTask("org_home", "a_taskver");
    assert.equal(seeded?.version, 1);

    const first = await repo.writeAgentTask(operator, "a_taskver", "first purpose\n");
    assert.equal(first.version, 2);
    const second = await repo.writeAgentTask(operator, "a_taskver", "second purpose\n");
    assert.equal(second.version, 3);
    const unchanged = await repo.writeAgentTask(operator, "a_taskver", "second purpose\n");
    assert.equal(unchanged.version, 3);

    const revisions = await repo.listAgentTaskRevisions("org_home", "a_taskver");
    assert.equal(revisions.length, 2);
    assert.equal(revisions[0]?.version, 2);
    assert.equal(revisions[0]?.content, "first purpose\n");
    assert.equal(revisions[1]?.version, 1);
    assert.equal(revisions[1]?.content, "seeded purpose\n");

    const restored = await repo.writeAgentTask(operator, "a_taskver", revisions[0].content);
    assert.equal(restored.version, 4);
    assert.equal(restored.content_text, "first purpose\n");
    const afterRestore = await repo.listAgentTaskRevisions("org_home", "a_taskver");
    assert.equal(afterRestore.length, 3);
    assert.equal(afterRestore[0]?.version, 3);
    assert.equal(afterRestore[0]?.content, "second purpose\n");

    await assert.rejects(
      () => repo.writeAgentTask(operator, "a_taskver", "stale editor\n", 3),
      (error: unknown) => error instanceof Error && error.message === "version conflict",
    );
    const cas = await repo.writeAgentTask(operator, "a_taskver", "cas purpose\n", 4);
    assert.equal(cas.version, 5);
  });
});
