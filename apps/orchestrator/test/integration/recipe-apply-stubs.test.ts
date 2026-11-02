import assert from "node:assert/strict";
import { after, test } from "node:test";
import { buildApp } from "../../src/app.js";
import { encryptPayload } from "../../src/credentials/crypto.js";
import { connect } from "../../src/seed/connect.js";
import { newId } from "../../src/lib/ids.js";
import { CALL_TOOL_TIMEOUT_MS } from "../../src/mcp/session.js";
import { mcpPool } from "../../src/mcp/pool.js";
import { proxyFetch } from "../../src/net/http.js";
import { NotesStore } from "../../src/notes/store.js";
import { recipeApply } from "../../src/recipes/apply.js";
import { operatorAuthor } from "../../src/recipes/schema.js";
import { agentScripts } from "../../src/scripts/catalog.js";
import { agentSchedules } from "../../src/schedules/service.js";
import { HEX_MASTER_KEY, tempDir } from "../helpers/env.js";
import { connectModelProvider } from "../helpers/models.js";
import { templatesRoot } from "../helpers/fixtures.js";
import { startMcpPingFixture } from "../helpers/mcp-fixture.js";
import {
  createIsolatedDatabase,
  dropIsolatedDatabase,
  uniqueDbName,
} from "../helpers/postgres.js";
import { fixtureDeskRecipe, fixtureHuskDeskRecipe, inboxQueueColumns } from "../helpers/recipe-docs.js";
import { insertConnector } from "../../src/db/connectors.js";
import { loadConnector } from "../../src/connectors/servers.js";
import { getAgentTask, listAgentTaskRevisions, listAgents } from "../../src/db/agents.js";
import { connectMcp } from "../../src/db/mcp.js";
import { listSchedules } from "../../src/db/schedules.js";
import { listBindingsCovering } from "../../src/db/bindings.js";
import { getByDisplayPath } from "../../src/artifacts/notes.js";
import { writeAgentTask } from "../../src/artifacts/task.js";
import { artifactStore } from "../../src/artifacts/store.js";
import { operatorActor } from "../../src/artifacts/actors.js";

const AUTH = {
  "X-Guilds-User": "user_operator",
  "X-Guilds-Org": "org_home",
};

const dbName = uniqueDbName("agent_platform_apply_stubs");

after(async () => {
  await dropIsolatedDatabase(dbName);
});

function enabledMcp(access: { mcp?: Array<Record<string, unknown>> }, slug: string) {
  return ((access.mcp ?? []) as Array<Record<string, unknown>>).find((row) => row.slug === slug);
}

function enabledToolNames(server: Record<string, unknown> | undefined): string[] {
  return ((server?.tools as Array<Record<string, unknown>> | undefined) ?? [])
    .filter((tool) => tool.enabled)
    .map((tool) => String(tool.name));
}

test("apply complete and husk two-agent recipes against stub mail and crm", { timeout: 90_000 }, async () => {
  process.env.SECRETS_MASTER_KEY = HEX_MASTER_KEY;
  const mailFx = await startMcpPingFixture();
  const crmFx = await startMcpPingFixture();
  const databaseUrl = await createIsolatedDatabase(dbName);
  const database = await connect(databaseUrl);
  const notes = new NotesStore(tempDir("guilds-apply-stubs-notes-"), templatesRoot());
  await notes.ensureSystemPrompt();
  const db = database.pool;
  await connectModelProvider(db, "org_home", "deepinfra");
  const artifacts = artifactStore(database.pool, templatesRoot());
  const scripts = agentScripts(db);
  const schedules = agentSchedules(db);
  const apply = recipeApply({ db, artifacts, notes, scripts, schedules, registry: null });
  const mcp = mcpPool(db);
  // The stub servers listen on loopback, which the pool refuses by default.
  mcp.endpointFetch = proxyFetch("", CALL_TOOL_TIMEOUT_MS);
  const app = await buildApp(database, {
    db,
    notes,
    artifacts,
    scripts,
    schedules,
    apply,
    mcp,
  });
  const now = new Date();
  const key = Buffer.from(HEX_MASTER_KEY, "hex");

  async function seedStub(slug: string, url: string) {
    const server = await insertConnector(db,
      {
        id: newId("mcp"),
        slug,
        toolPrefix: slug,
        ownerOrgId: null,
        manifest: {
          slug,
          display_name: slug,
          endpoint: { url },
          auth: { kind: "token" },
          description: `Stub ${slug} connector`,
          setup_hint: `Connect ${slug}.`,
          tools: [{ name: "ping", description: "Ping", input_schema: { type: "object" } }],
        },
        source: "local",
        verified: false,
        publisher: "",
        enabled: true,
      },
      now,
    );
    return loadConnector(server);
  }

  async function importRecipe(body: unknown) {
    const imported = await app.inject({
      method: "POST",
      url: "/api/recipes/import",
      headers: { ...AUTH, "content-type": "application/json" },
      payload: { recipe: body },
    });
    assert.equal(imported.statusCode, 201, imported.body);
    return String(imported.json().id);
  }

  async function markReady(recipeId: string) {
    const validated = await app.inject({
      method: "POST",
      url: `/api/recipes/${recipeId}/validate`,
      headers: AUTH,
    });
    assert.equal(validated.statusCode, 200, validated.body);
    const published = await app.inject({
      method: "POST",
      url: `/api/recipes/${recipeId}/publish`,
      headers: AUTH,
    });
    assert.equal(published.statusCode, 200, published.body);
  }

  async function importReady(body: unknown) {
    const id = await importRecipe(body);
    await markReady(id);
    return id;
  }

  async function previewRecipe(recipeId: string) {
    const response = await app.inject({
      method: "POST",
      url: `/api/recipes/${recipeId}/preview`,
      headers: { ...AUTH, "content-type": "application/json" },
      payload: {},
    });
    assert.equal(response.statusCode, 200, response.body);
    return response.json() as {
      errors: Array<{ code: string; message: string }>;
      findings: unknown[];
      creates: {
        agents: Array<{ role: string; name: string; task: string }>;
        routines: Array<{ role: string; key: string; cron: string }>;
        connections: Array<{
          server: string;
          action: string;
          connection_id?: string | null;
        }>;
        collections: Array<{
          name: string;
          columns: unknown;
          guild: string;
          writers: string[];
          action: string;
          collection_id: string | null;
          differences: string[];
        }>;
      };
      connections: Array<{ server: string; action: string; connection_id?: string | null }>;
    };
  }

  type CollectionRow = { id: string; name: string; columns: unknown; count?: number };

  async function listCollections(): Promise<CollectionRow[]> {
    const response = await app.inject({ method: "GET", url: "/api/collections", headers: AUTH });
    assert.equal(response.statusCode, 200, response.body);
    return response.json() as CollectionRow[];
  }

  type AccessEntry = { type: string; id: string; name: string; mode: string };

  async function collectionAccess(collectionId: string): Promise<AccessEntry[]> {
    const response = await app.inject({
      method: "GET",
      url: `/api/collections/${collectionId}/access`,
      headers: AUTH,
    });
    assert.equal(response.statusCode, 200, response.body);
    return (response.json() as { subjects: AccessEntry[] }).subjects;
  }

  async function noteAccess(noteId: string): Promise<AccessEntry[]> {
    const response = await app.inject({ method: "GET", url: `/api/notes/${noteId}/access`, headers: AUTH });
    assert.equal(response.statusCode, 200, response.body);
    return (response.json() as { subjects: AccessEntry[] }).subjects;
  }

  function modeOf(entries: AccessEntry[], subject: { type: string; id: string }): string | null {
    return entries.find((entry) => entry.type === subject.type && entry.id === subject.id)?.mode ?? null;
  }

  async function applyRecipe(recipeId: string, guildName: string) {
    const response = await app.inject({
      method: "POST",
      url: `/api/recipes/${recipeId}/apply`,
      headers: { ...AUTH, "content-type": "application/json" },
      payload: { guild_name: guildName },
    });
    assert.equal(response.statusCode, 201, response.body);
    return response.json() as {
      id: string;
      guild_id: string;
      checklist: Array<{ id: string; status: string }>;
    };
  }

  async function assertLiveTask(guildId: string, agentId: string, pattern: RegExp) {
    const row = await getAgentTask(db, "org_home", agentId);
    assert.ok(row?.content_text);
    assert.match(row.content_text, pattern);
    assert.equal(row.version, 1);
    const revisions = await listAgentTaskRevisions(db, "org_home", agentId);
    assert.equal(revisions.length, 0);
  }

  try {
    const mailServer = await seedStub("mail", mailFx.url);
    const crmServer = await seedStub("crm", crmFx.url);

    const huskId = await importRecipe(fixtureHuskDeskRecipe());
    const beforeConnect = await previewRecipe(huskId);
    assert.ok(beforeConnect.findings.length);
    assert.equal(beforeConnect.creates.agents.length, 2);
    const plannedInbox = beforeConnect.creates.collections.find((row) => row.name === "inbox-queue");
    assert.deepEqual(plannedInbox?.columns, inboxQueueColumns());
    assert.equal(plannedInbox?.action, "create");
    assert.equal(plannedInbox?.collection_id, null);
    assert.equal(plannedInbox?.guild, "write");
    assert.ok(beforeConnect.creates.agents.every((item) => item.task.trim().length > 20));
    assert.equal(beforeConnect.creates.routines.length, 0);
    assert.equal(beforeConnect.creates.connections.length, 0);
    const huskBlocked = await app.inject({
      method: "POST",
      url: `/api/recipes/${huskId}/apply`,
      headers: { ...AUTH, "content-type": "application/json" },
      payload: { guild_name: "fixture-husk-unconnected" },
    });
    assert.equal(huskBlocked.statusCode, 422, huskBlocked.body);

    const disconnectedId = await importReady(fixtureDeskRecipe());
    const disconnectedApply = await applyRecipe(disconnectedId, "fixture-husk-unconnected");
    const twice = await app.inject({
      method: "POST",
      url: `/api/recipes/${disconnectedId}/apply`,
      headers: { ...AUTH, "content-type": "application/json" },
      payload: { guild_name: "fixture-husk-twice" },
    });
    assert.equal(twice.statusCode, 409, twice.body);
    assert.match(String(twice.json().detail), /^agent names already exist: /);
    const verifyMail = await app.inject({
      method: "POST",
      url: `/api/applies/${disconnectedApply.id}/steps/${encodeURIComponent("conn:mail")}/verify`,
      headers: AUTH,
    });
    assert.equal(verifyMail.statusCode, 422, verifyMail.body);
    assert.match(String(verifyMail.json().detail), /mail is not connected yet/);
    const abortedDisconnected = await app.inject({
      method: "POST",
      url: `/api/applies/${disconnectedApply.id}/abort`,
      headers: AUTH,
    });
    assert.equal(abortedDisconnected.statusCode, 200, abortedDisconnected.body);

    for (const server of [mailServer, crmServer]) {
      const [ciphertext, nonce] = encryptPayload({ token: `${server.slug}-test` }, key);
      const connection = await connectMcp(db,
        {
          connectionId: newId("conn"),
          bindingId: newId("bind"),
          serverId: String(server.id),
          ownerScope: "org",
          ownerId: "org_home",
          ciphertext,
          nonce,
          status: "connected",
          bind: false,
        },
        now,
      );
      const listed = await mcp.syncTools(connection, server, { force: true });
      assert.deepEqual(
        listed.map((tool) => tool.namespaced_name),
        [`${server.slug}_ping`],
      );
    }
    assert.ok(mailFx.listed >= 1);
    assert.ok(crmFx.listed >= 1);

    const afterConnect = await previewRecipe(disconnectedId);
    assert.ok(afterConnect.creates.connections.every((item) => item.action === "reuse" && item.connection_id));

    const completeId = await importReady(fixtureDeskRecipe());
    const completePreview = await previewRecipe(completeId);
    assert.equal(completePreview.errors.length, 0);
    assert.equal(completePreview.creates.agents.length, 2);
    assert.match(completePreview.creates.agents.find((item) => item.role === "reader")?.task ?? "", /mail_ping/);
    assert.match(completePreview.creates.agents.find((item) => item.role === "writer")?.task ?? "", /crm_ping/);
    assert.deepEqual(
      completePreview.creates.routines.map((item) => `${item.role}:${item.cron}`).sort(),
      ["reader:*/15 * * * *", "writer:*/20 * * * *"],
    );
    assert.ok(completePreview.creates.connections.every((item) => item.action === "reuse"));

    const completeApply = await applyRecipe(completeId, "fixture-desk");
    const completeAgents = await listAgents(db, completeApply.guild_id);
    assert.equal(completeAgents.length, 2);
    const deskReader = completeAgents.find((row) => row.name === "desk-reader");
    const deskWriter = completeAgents.find((row) => row.name === "desk-writer");
    assert.ok(deskReader && deskWriter);

    // The first apply created both tables at the organisation with the
    // recipe's columns. The organisation's read row already gives the guild
    // read, so only the guild's write and the writer role's write are added.
    const tablesAfterFirst = await listCollections();
    const seenIds = tablesAfterFirst.find((row) => row.name === "seen-ids");
    const inboxQueue = tablesAfterFirst.find((row) => row.name === "inbox-queue");
    assert.ok(seenIds && inboxQueue);
    assert.deepEqual(inboxQueue.columns, inboxQueueColumns());
    const deskPod = { type: "guild", id: completeApply.guild_id };
    const seenIdsAccess = await collectionAccess(seenIds.id);
    const inboxQueueAccess = await collectionAccess(inboxQueue.id);
    assert.equal(modeOf(seenIdsAccess, { type: "org", id: "org_home" }), "read");
    assert.equal(modeOf(seenIdsAccess, deskPod), null);
    assert.equal(modeOf(inboxQueueAccess, deskPod), "write");
    assert.equal(modeOf(seenIdsAccess, { type: "agent", id: String(deskReader.id) }), "write");
    assert.equal(modeOf(seenIdsAccess, { type: "agent", id: String(deskWriter.id) }), null);
    assert.equal(modeOf(inboxQueueAccess, { type: "agent", id: String(deskWriter.id) }), null);

    // A second apply of the same recipe reuses the tables instead of creating them.
    const reusePreview = await previewRecipe(completeId);
    assert.equal(reusePreview.errors.length, 0);
    assert.ok(reusePreview.creates.collections.every((row) => row.action === "reuse"));
    assert.equal(reusePreview.creates.collections.find((row) => row.name === "inbox-queue")?.collection_id, inboxQueue.id);

    // A recipe whose table of the same name has different columns cannot apply.
    const clashing = fixtureDeskRecipe();
    clashing.guild.name_suggestion = "fixture-desk-clash";
    clashing.roles[0]!.name_suggestion = "clash-reader";
    clashing.roles[1]!.name_suggestion = "clash-writer";
    const clashQueue = clashing.collections.find((row) => row.name === "inbox-queue")!;
    clashQueue.columns = [
      ...clashQueue.columns.filter((column) => column.name !== "status" && column.name !== "subject"),
      { name: "status", type: "text", description: "state", required: true, unique: false, values: ["queued", "done"] },
      { name: "subject", type: "number", description: "not text any more", required: false, unique: false },
    ];
    const clashId = await importReady(clashing);
    const clashPreview = await previewRecipe(clashId);
    const conflict = clashPreview.errors.find((row) => row.code === "collection.conflict");
    assert.ok(conflict, JSON.stringify(clashPreview.errors));
    assert.match(conflict.message, /inbox-queue/);
    assert.match(conflict.message, /subject is text, the recipe needs number/);
    assert.match(conflict.message, /status does not accept done/);
    const clashPlan = clashPreview.creates.collections.find((row) => row.name === "inbox-queue");
    assert.equal(clashPlan?.action, "conflict");
    assert.equal(clashPlan?.differences.length, 2);
    assert.equal(clashPreview.creates.collections.find((row) => row.name === "seen-ids")?.action, "reuse");
    const clashApply = await app.inject({
      method: "POST",
      url: `/api/recipes/${clashId}/apply`,
      headers: { ...AUTH, "content-type": "application/json" },
      payload: { guild_name: "fixture-desk-clash" },
    });
    assert.equal(clashApply.statusCode, 422, clashApply.body);
    assert.match(String(clashApply.json().detail), /collection inbox-queue already exists/);
    assert.equal((await listCollections()).length, tablesAfterFirst.length);
    await assertLiveTask(completeApply.guild_id, String(deskReader.id), /Call mail_ping/);
    await assertLiveTask(completeApply.guild_id, String(deskWriter.id), /Call crm_ping/);
    const readerSchedules = await listSchedules(db, String(deskReader.id));
    const writerSchedules = await listSchedules(db, String(deskWriter.id));
    assert.equal(readerSchedules.length, 1);
    assert.equal(readerSchedules[0]?.cron, "*/15 * * * *");
    assert.equal(readerSchedules[0]?.paused, true);
    assert.equal(writerSchedules.length, 1);
    assert.equal(writerSchedules[0]?.cron, "*/20 * * * *");
    assert.equal(writerSchedules[0]?.paused, true);
    const orgMcp = (await listBindingsCovering(db, { orgId: "org_home" })).filter(
      (row) => row.scope === "org" && row.catalog_kind === "mcp",
    );
    assert.equal(orgMcp.length, 0);
    const readerBindings = await listBindingsCovering(db, {
      orgId: "org_home",
      guildId: completeApply.guild_id,
      agentId: String(deskReader.id),
    });
    const writerBindings = await listBindingsCovering(db, {
      orgId: "org_home",
      guildId: completeApply.guild_id,
      agentId: String(deskWriter.id),
    });
    assert.ok(
      readerBindings.some(
        (row) =>
          row.catalog_kind === "mcp" &&
          row.scope === "agent" &&
          String(row.catalog_id) === String(mailServer.id) &&
          row.enabled === true,
      ),
    );
    assert.equal(
      readerBindings.some(
        (row) => row.catalog_kind === "mcp" && String(row.catalog_id) === String(crmServer.id) && row.enabled === true,
      ),
      false,
    );
    assert.ok(
      writerBindings.some(
        (row) =>
          row.catalog_kind === "mcp" &&
          row.scope === "agent" &&
          String(row.catalog_id) === String(crmServer.id) &&
          row.enabled === true,
      ),
    );
    const readerAccess = await app.inject({
      method: "GET",
      url: `/api/agents/${deskReader.id}/access`,
      headers: AUTH,
    });
    const writerAccess = await app.inject({
      method: "GET",
      url: `/api/agents/${deskWriter.id}/access`,
      headers: AUTH,
    });
    assert.equal(readerAccess.statusCode, 200, readerAccess.body);
    assert.equal(writerAccess.statusCode, 200, writerAccess.body);
    const readerMail = enabledMcp(readerAccess.json(), "mail");
    const readerCrm = enabledMcp(readerAccess.json(), "crm");
    const writerMail = enabledMcp(writerAccess.json(), "mail");
    const writerCrm = enabledMcp(writerAccess.json(), "crm");
    assert.equal(readerMail?.enabled, true);
    assert.deepEqual(enabledToolNames(readerMail), ["mail_ping"]);
    assert.equal(Boolean(readerCrm?.enabled), false);
    assert.equal(Boolean(writerMail?.enabled), false);
    assert.equal(writerCrm?.enabled, true);
    assert.deepEqual(enabledToolNames(writerCrm), ["crm_ping"]);
    assert.ok(completeApply.checklist.filter((step) => step.id.startsWith("conn:")).every((step) => step.status === "verified"));
    assert.ok(
      completeApply.checklist.filter((step) => step.id.startsWith("overlays:")).every((step) => step.status === "verified"),
    );

    const mixed = fixtureDeskRecipe();
    mixed.guild.name_suggestion = "fixture-desk-mixed";
    mixed.roles[0]!.name_suggestion = "mixed-reader";
    mixed.roles[1]!.name_suggestion = "mixed-writer";
    mixed.connections[0]!.recommended_scope = "guild";
    mixed.connections[1]!.recommended_scope = "guild";
    mixed.notes = [
      {
        id: "desk-rules",
        key: "desk-rules.md",
        body: "Skip thread ids already in seen-ids.\n",
        kind: "seed",
        author: operatorAuthor(),
        writers: [],
      },
      {
        id: "crm-map",
        key: "crm-map.md",
        body: "Map the sender to one CRM person.\n",
        kind: "seed",
        author: operatorAuthor(),
        guild: "read",
        writers: ["writer", "reader"],
      },
      {
        id: "mixed-glossary",
        key: "mixed-glossary.md",
        body: "Thread: one mail conversation.\n",
        kind: "seed",
        author: operatorAuthor(),
        org: "read",
        guild: "write",
        writers: [],
      },
    ];
    mixed.roles[0]!.task.body += "\n\n![[org/desk-rules.md]]";
    mixed.roles[0]!.task.embeds = ["org/desk-rules.md"];
    mixed.roles[1]!.task.body += "\n\n![[org/crm-map.md]]\n\nThen note_get org/desk-rules.md.";
    mixed.roles[1]!.schedules[0]!.instruction += " Read org/crm-map.md first.";
    mixed.roles[1]!.task.embeds = ["org/crm-map.md"];
    const mixedId = await importReady(mixed);
    const mixedApply = await applyRecipe(mixedId, "fixture-desk-mixed");
    const mixedAgents = await listAgents(db, mixedApply.guild_id);
    const mixedReader = mixedAgents.find((row) => row.name === "mixed-reader");
    const mixedWriter = mixedAgents.find((row) => row.name === "mixed-writer");
    assert.ok(mixedReader && mixedWriter);

    // Recipe notes land flat at the organisation, and task embeds point at the written files.
    const rulesPath = "org/org_home/desk-rules.md";
    const mapPath = "org/org_home/crm-map.md";
    const mixedReaderTask = await getAgentTask(db, "org_home", String(mixedReader.id));
    const mixedWriterTask = await getAgentTask(db, "org_home", String(mixedWriter.id));
    assert.ok(mixedReaderTask?.content_text.includes(`![[${rulesPath}]]`));
    assert.ok(mixedWriterTask?.content_text.includes(`![[${mapPath}]]`));
    assert.ok(mixedWriterTask?.content_text.includes(`Then note_get ${rulesPath}.`));
    const mixedWriterSchedules = await listSchedules(db, String(mixedWriter.id));
    assert.ok(mixedWriterSchedules.some((row) => String(row.instruction).includes(`Read ${mapPath} first.`)));
    const noteReader = operatorActor({
      orgId: "org_home",
      actorId: "user_operator",
      actorName: "operator",
      guildId: mixedApply.guild_id,
      agentId: String(mixedWriter.id),
    });
    const rulesNote = await getByDisplayPath(artifacts, noteReader, rulesPath);
    assert.equal(rulesNote.row?.key, "desk-rules.md");
    assert.equal(rulesNote.row?.path, "");
    assert.equal(rulesNote.row?.content_text, "Skip thread ids already in seen-ids.\n");
    const mapNote = await getByDisplayPath(artifacts, noteReader, mapPath);
    assert.equal(mapNote.row?.key, "crm-map.md");
    assert.equal(mapNote.row?.path, "");
    // Each note's access list is the recipe's guild mode and writers; a note that states neither is written by the guild.
    const mixedGuild = { type: "guild", id: mixedApply.guild_id };
    const mapAccess = await noteAccess(String(mapNote.row?.id));
    assert.equal(modeOf(mapAccess, mixedGuild), "read");
    assert.equal(modeOf(mapAccess, { type: "agent", id: String(mixedReader.id) }), "write");
    assert.equal(modeOf(mapAccess, { type: "agent", id: String(mixedWriter.id) }), "write");
    const rulesAccess = await noteAccess(String(rulesNote.row?.id));
    assert.deepEqual(rulesAccess.length, 1);
    assert.equal(modeOf(rulesAccess, mixedGuild), "write");
    const glossary = await getByDisplayPath(artifacts, noteReader, "org/org_home/mixed-glossary.md");
    const glossaryAccess = await noteAccess(String(glossary.row?.id));
    assert.equal(modeOf(glossaryAccess, { type: "org", id: "org_home" }), "read", "an org mode is the organisation's row");
    assert.equal(modeOf(glossaryAccess, mixedGuild), "write");
    assert.equal(modeOf(rulesAccess, { type: "org", id: "org_home" }), null);

    // A note key the organisation already uses is written under the new guild's name, and the Task points at it.
    const repeat = (guildName: string, prefix: string) => {
      const recipe = fixtureDeskRecipe();
      recipe.guild.name_suggestion = guildName;
      recipe.roles[0]!.name_suggestion = `${prefix}-reader`;
      recipe.roles[1]!.name_suggestion = `${prefix}-writer`;
      recipe.connections[0]!.recommended_scope = "guild";
      recipe.connections[1]!.recommended_scope = "guild";
      recipe.notes = [
        { id: "desk-rules", key: "desk-rules.md", body: "Again.\n", kind: "seed", author: operatorAuthor(), writers: [] },
      ];
      recipe.roles[0]!.task.body += "\n\n![[org/desk-rules.md]]";
      recipe.roles[0]!.task.embeds = ["org/desk-rules.md"];
      return recipe;
    };
    const againApply = await applyRecipe(await importReady(repeat("fixture-desk-again", "again")), "fixture-desk-again");
    const againReader = (await listAgents(db, againApply.guild_id)).find((row) => row.name === "again-reader");
    assert.ok(againReader);
    const againPath = "org/org_home/fixture-desk-again-desk-rules.md";
    assert.ok((await getAgentTask(db, "org_home", String(againReader.id)))?.content_text.includes(`![[${againPath}]]`));
    assert.equal((await getByDisplayPath(artifacts, noteReader, againPath)).row?.content_text, "Again.\n");
    assert.equal(
      (await getByDisplayPath(artifacts, noteReader, rulesPath)).row?.content_text,
      "Skip thread ids already in seen-ids.\n",
      "the note already there is left as it was",
    );

    // When the prefixed key is taken too, the apply is refused and nothing it made stays.
    const taken = await app.inject({
      method: "PUT",
      url: "/api/org/notes/fixture-desk-third-desk-rules.md",
      headers: { ...AUTH, "content-type": "application/json" },
      payload: { content: "Taken.\n" },
    });
    assert.equal(taken.statusCode, 200, taken.body);
    const third = repeat("fixture-desk-third", "third");
    // A note the organisation's row alone reaches, written before the one that fails.
    third.notes.unshift({
      id: "third-glossary",
      key: "third-glossary.md",
      body: "Only the organisation reads this.\n",
      kind: "seed",
      author: operatorAuthor(),
      org: "read",
      writers: [],
    });
    const thirdId = await importReady(third);
    const refused = await app.inject({
      method: "POST",
      url: `/api/recipes/${thirdId}/apply`,
      headers: { ...AUTH, "content-type": "application/json" },
      payload: { guild_name: "fixture-desk-third" },
    });
    assert.equal(refused.statusCode, 409, refused.body);
    const guildsAfter = await app.inject({ method: "GET", url: "/api/guilds", headers: AUTH });
    assert.equal(
      (guildsAfter.json() as Array<{ name: string }>).some((guild) => guild.name === "fixture-desk-third"),
      false,
      "the refused apply leaves no guild",
    );
    assert.equal((await getByDisplayPath(artifacts, noteReader, "org/org_home/fixture-desk-third-desk-rules.md")).row?.content_text, "Taken.\n");
    const orgOnly = await getByDisplayPath(artifacts, noteReader, "org/org_home/third-glossary.md");
    assert.equal(orgOnly.tombstone, true, "the refused apply deletes a note it wrote, whatever its rows");

    // An abort deletes what the apply made as a failed apply does, its notes included.
    const aborting = repeat("fixture-desk-abort", "abort");
    aborting.notes = [
      { id: "abort-glossary", key: "abort-glossary.md", body: "Read by all.\n", kind: "seed", author: operatorAuthor(), org: "read", writers: [] },
      { id: "abort-rules", key: "abort-rules.md", body: "Ours.\n", kind: "seed", author: operatorAuthor(), writers: [] },
    ];
    aborting.roles[0]!.task.body = aborting.roles[0]!.task.body.replace("![[org/desk-rules.md]]", "![[org/abort-rules.md]]");
    aborting.roles[0]!.task.embeds = ["org/abort-rules.md"];
    const abortApplied = await applyRecipe(await importReady(aborting), "fixture-desk-abort");
    assert.equal((await getByDisplayPath(artifacts, noteReader, "org/org_home/abort-glossary.md")).tombstone, undefined);
    const aborted = await app.inject({ method: "POST", url: `/api/applies/${abortApplied.id}/abort`, headers: AUTH });
    assert.equal(aborted.statusCode, 200, aborted.body);
    for (const key of ["abort-glossary.md", "abort-rules.md"]) {
      assert.equal((await getByDisplayPath(artifacts, noteReader, `org/org_home/${key}`)).tombstone, true, `${key} goes with the abort`);
    }
    assert.deepEqual(await listAgents(db, abortApplied.guild_id), []);

    const abort = (applyId: string) => app.inject({ method: "POST", url: `/api/applies/${applyId}/abort`, headers: AUTH });
    const applyStatus = async (applyId: string) =>
      (await db.query<{ status: string }>("SELECT status FROM recipe_applies WHERE id = $1", [applyId])).rows[0]?.status;
    const solo = (guildName: string, prefix: string, key: string) => {
      const recipe = repeat(guildName, prefix);
      recipe.notes = [{ id: key, key, body: "Mine.\n", kind: "seed", author: operatorAuthor(), writers: [] }];
      recipe.roles[0]!.task.body = recipe.roles[0]!.task.body.replace("![[org/desk-rules.md]]", `![[org/${key}]]`);
      recipe.roles[0]!.task.embeds = [`org/${key}`];
      return recipe;
    };

    // An item whose rows name only two of the apply's agents goes with the second of them.
    const shareApplied = await applyRecipe(await importReady(solo("fixture-desk-share", "share", "share-rules.md")), "fixture-desk-share");
    const shareAgents = await listAgents(db, shareApplied.guild_id);
    const sharedNote = await app.inject({
      method: "PUT",
      url: "/api/org/notes/share-between.md",
      headers: { ...AUTH, "content-type": "application/json" },
      payload: { content: "Between the two.\n", access: { type: "agent", id: String(shareAgents[0]?.id), mode: "write" } },
    });
    assert.equal(sharedNote.statusCode, 200, sharedNote.body);
    const sharedAccess = await app.inject({
      method: "PUT",
      url: `/api/notes/${String(sharedNote.json().id)}/access`,
      headers: { ...AUTH, "content-type": "application/json" },
      payload: { subjects: shareAgents.map((agent) => ({ type: "agent", id: String(agent.id), mode: "write" })) },
    });
    assert.equal(sharedAccess.statusCode, 200, sharedAccess.body);
    assert.equal((await abort(shareApplied.id)).statusCode, 200);
    assert.equal(
      (await getByDisplayPath(artifacts, noteReader, "org/org_home/share-between.md")).tombstone,
      true,
      "a note only the apply's agents reached goes with them",
    );

    // A deletion the store refuses is reported, and the apply is not marked aborted.
    // The note is read by the whole organisation, so the guild's deletion does not take it and its own deletion is refused.
    const embedding = solo("fixture-desk-embed", "embed", "embed-rules.md");
    embedding.notes[0]!.org = "read";
    const embedApplied = await applyRecipe(await importReady(embedding), "fixture-desk-embed");
    await writeAgentTask(db, noteReader, String(mixedReader.id), { content: "Follow ![[org/org_home/embed-rules.md]]\n" });
    const refusedAbort = await abort(embedApplied.id);
    assert.equal(refusedAbort.statusCode, 409, refusedAbort.body);
    assert.match(refusedAbort.body, /undoing the apply left part of it in place: note [^:]+: note is embedded in task/);
    assert.notEqual(await applyStatus(embedApplied.id), "aborted");
    assert.equal((await getByDisplayPath(artifacts, noteReader, "org/org_home/embed-rules.md")).tombstone, undefined);
    await writeAgentTask(db, noteReader, String(mixedReader.id), { content: "Read the inbox.\n" });

    const mixedReaderBindings = await listBindingsCovering(db, {
      orgId: "org_home",
      guildId: mixedApply.guild_id,
      agentId: String(mixedReader.id),
    });
    const mixedWriterBindings = await listBindingsCovering(db, {
      orgId: "org_home",
      guildId: mixedApply.guild_id,
      agentId: String(mixedWriter.id),
    });
    assert.equal(
      mixedReaderBindings.some((row) => row.catalog_kind === "mcp" && row.scope === "guild"),
      false,
    );
    assert.ok(
      mixedReaderBindings.some(
        (row) =>
          row.catalog_kind === "mcp" &&
          row.scope === "agent" &&
          String(row.catalog_id) === String(mailServer.id) &&
          row.enabled === true,
      ),
    );
    assert.equal(
      mixedReaderBindings.some(
        (row) => row.catalog_kind === "mcp" && String(row.catalog_id) === String(crmServer.id) && row.enabled === true,
      ),
      false,
    );
    assert.ok(
      mixedWriterBindings.some(
        (row) =>
          row.catalog_kind === "mcp" &&
          row.scope === "agent" &&
          String(row.catalog_id) === String(crmServer.id) &&
          row.enabled === true,
      ),
    );

    const shared = fixtureDeskRecipe();
    shared.guild.name_suggestion = "fixture-desk-shared";
    shared.roles[0]!.name_suggestion = "shared-reader";
    shared.roles[1]!.name_suggestion = "shared-writer";
    shared.connections[0]!.recommended_scope = "guild";
    shared.connections[0]!.roles = {
      reader: { enabled: true, tools: { mail_ping: true } },
      writer: { enabled: true, tools: { mail_ping: true } },
    };
    const sharedId = await importReady(shared);
    const sharedApply = await applyRecipe(sharedId, "fixture-desk-shared");
    const sharedBindings = await listBindingsCovering(db, {
      orgId: "org_home",
      guildId: sharedApply.guild_id,
    });
    assert.ok(
      sharedBindings.some(
        (row) =>
          row.catalog_kind === "mcp" &&
          row.scope === "guild" &&
          String(row.catalog_id) === String(mailServer.id) &&
          row.enabled === true,
      ),
    );

    await markReady(huskId);
    const huskApply = await applyRecipe(huskId, "fixture-husk-desk");
    const huskAgents = await listAgents(db, huskApply.guild_id);
    assert.equal(huskAgents.length, 2);
    const huskReader = huskAgents.find((row) => row.name === "husk-reader");
    const huskWriter = huskAgents.find((row) => row.name === "husk-writer");
    assert.ok(huskReader && huskWriter);
    await assertLiveTask(huskApply.guild_id, String(huskReader.id), /Read mail threads/);
    await assertLiveTask(huskApply.guild_id, String(huskWriter.id), /Write CRM rows/);
    for (const member of [huskReader, huskWriter]) {
      const rows = await listSchedules(db, String(member.id));
      assert.equal(rows.length, 0);
    }
    // The husk's inbox-queue matches the live table column for column, so the
    // guild is granted the existing table and no second one appears.
    const huskTables = await listCollections();
    assert.equal(huskTables.filter((row) => row.name === "inbox-queue").length, 1);
    assert.equal(huskTables.find((row) => row.name === "inbox-queue")?.id, inboxQueue.id);
    assert.deepEqual(huskTables.find((row) => row.name === "inbox-queue")?.columns, inboxQueueColumns());
    const huskGuild = { type: "guild", id: huskApply.guild_id };
    assert.equal(modeOf(await collectionAccess(inboxQueue.id), huskGuild), "write");
    assert.equal(modeOf(await collectionAccess(seenIds.id), huskGuild), null);
    const huskGuildBindings = await listBindingsCovering(db, {
      orgId: "org_home",
      guildId: huskApply.guild_id,
    });
    assert.equal(
      huskGuildBindings.some((row) => row.catalog_kind === "mcp"),
      false,
    );
    const huskReaderAccess = await app.inject({
      method: "GET",
      url: `/api/agents/${huskReader.id}/access`,
      headers: AUTH,
    });
    assert.equal(huskReaderAccess.statusCode, 200, huskReaderAccess.body);
    assert.equal(Boolean(enabledMcp(huskReaderAccess.json(), "mail")?.enabled), false);
    assert.equal(Boolean(enabledMcp(huskReaderAccess.json(), "crm")?.enabled), false);
  } finally {
    await app.close();
    await database.close();
    await mailFx.close();
    await crmFx.close();
  }
});
