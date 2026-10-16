import assert from "node:assert/strict";
import { after, test } from "node:test";
import { ArtifactStore } from "../../src/artifacts/index.js";
import { buildApp } from "../../src/app.js";
import { encryptPayload } from "../../src/credentials/crypto.js";
import { connect } from "../../src/db/client.js";
import { Repositories } from "../../src/db/repositories.js";
import { newId } from "../../src/lib/ids.js";
import { CALL_TOOL_TIMEOUT_MS, McpPool } from "../../src/mcp/index.js";
import { proxyFetch } from "../../src/net/http.js";
import { NotesStore } from "../../src/notes/store.js";
import { RecipeApplyService } from "../../src/recipes/apply.js";
import { operatorAuthor } from "../../src/recipes/schema.js";
import { RecipeStore } from "../../src/recipes/store.js";
import { Scripts } from "../../src/scripts/catalog.js";
import { Schedules } from "../../src/schedules/service.js";
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
  const notes = new NotesStore(tempDir("guilds-apply-stubs-notes-"), templatesRoot(), "notes");
  await notes.ensureSystemPrompt();
  const repo = new Repositories(database.pool);
  await connectModelProvider(repo, "org_home", "deepinfra");
  const artifacts = new ArtifactStore(database.pool, templatesRoot());
  const scripts = new Scripts(repo);
  const schedules = new Schedules(repo, notes);
  const recipes = new RecipeStore(repo.pool);
  const apply = new RecipeApplyService({ repo, recipes, artifacts, notes, scripts, schedules, registry: null });
  const mcp = new McpPool();
  // The stub servers listen on loopback, which the pool refuses by default.
  mcp.endpointFetch = proxyFetch("", CALL_TOOL_TIMEOUT_MS);
  const app = await buildApp(database, {
    repo,
    notes,
    artifacts,
    scripts,
    schedules,
    recipes,
    apply,
    mcp,
  });
  const now = new Date();
  const key = Buffer.from(HEX_MASTER_KEY, "hex");

  async function seedStub(slug: string, url: string) {
    const server = await repo.insertConnector(
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
    return server;
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

  async function guildAccess(guildId: string): Promise<Array<{ collection_id: string; name: string; mode: string | null }>> {
    const response = await app.inject({
      method: "GET",
      url: `/api/guilds/${guildId}/collection-access`,
      headers: AUTH,
    });
    assert.equal(response.statusCode, 200, response.body);
    return response.json() as Array<{ collection_id: string; name: string; mode: string | null }>;
  }

  async function agentAccess(
    agentId: string,
  ): Promise<Array<{ name: string; guild_mode: string | null; agent_mode: string | null; effective: string | null }>> {
    const response = await app.inject({
      method: "GET",
      url: `/api/agents/${agentId}/collection-access`,
      headers: AUTH,
    });
    assert.equal(response.statusCode, 200, response.body);
    return response.json() as Array<{
      name: string;
      guild_mode: string | null;
      agent_mode: string | null;
      effective: string | null;
    }>;
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
    const row = await repo.getAgentTask("org_home", agentId);
    assert.ok(row?.content_text);
    assert.match(row.content_text, pattern);
    assert.equal(row.version, 1);
    const revisions = await repo.listAgentTaskRevisions("org_home", agentId);
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
      const connection = await repo.connectMcp(
        newId("conn"),
        newId("bind"),
        String(server.id),
        "org",
        "org_home",
        ciphertext,
        nonce,
        now,
        { status: "connected", bind: false },
      );
      const listed = await mcp.syncTools(repo, connection, server, { force: true });
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
    const completeAgents = await repo.listAgents(completeApply.guild_id);
    assert.equal(completeAgents.length, 2);
    const deskReader = completeAgents.find((row) => row.name === "desk-reader");
    const deskWriter = completeAgents.find((row) => row.name === "desk-writer");
    assert.ok(deskReader && deskWriter);

    // The first apply created both tables at the organisation with the
    // recipe's columns and granted the guild and the writer role.
    const tablesAfterFirst = await listCollections();
    const seenIds = tablesAfterFirst.find((row) => row.name === "seen-ids");
    const inboxQueue = tablesAfterFirst.find((row) => row.name === "inbox-queue");
    assert.ok(seenIds && inboxQueue);
    assert.deepEqual(inboxQueue.columns, inboxQueueColumns());
    const deskPodAccess = await guildAccess(completeApply.guild_id);
    assert.equal(deskPodAccess.find((row) => row.name === "seen-ids")?.mode, "read");
    assert.equal(deskPodAccess.find((row) => row.name === "inbox-queue")?.mode, "write");
    const readerCollections = await agentAccess(String(deskReader.id));
    const writerCollections = await agentAccess(String(deskWriter.id));
    assert.equal(readerCollections.find((row) => row.name === "seen-ids")?.agent_mode, "write");
    assert.equal(readerCollections.find((row) => row.name === "seen-ids")?.effective, "write");
    assert.equal(writerCollections.find((row) => row.name === "seen-ids")?.agent_mode, null);
    assert.equal(writerCollections.find((row) => row.name === "seen-ids")?.effective, "read");
    assert.equal(writerCollections.find((row) => row.name === "inbox-queue")?.effective, "write");

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
    const readerSchedules = await repo.listSchedules(String(deskReader.id));
    const writerSchedules = await repo.listSchedules(String(deskWriter.id));
    assert.equal(readerSchedules.length, 1);
    assert.equal(readerSchedules[0]?.cron, "*/15 * * * *");
    assert.equal(readerSchedules[0]?.paused, true);
    assert.equal(writerSchedules.length, 1);
    assert.equal(writerSchedules[0]?.cron, "*/20 * * * *");
    assert.equal(writerSchedules[0]?.paused, true);
    const orgMcp = (await repo.listBindingsCovering({ orgId: "org_home" })).filter(
      (row) => row.scope === "org" && row.catalog_kind === "mcp",
    );
    assert.equal(orgMcp.length, 0);
    const readerBindings = await repo.listBindingsCovering({
      orgId: "org_home",
      guildId: completeApply.guild_id,
      agentId: String(deskReader.id),
    });
    const writerBindings = await repo.listBindingsCovering({
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
        level: "guild",
        key: "desk-rules.md",
        body: "Skip thread ids already in seen-ids.\n",
        kind: "seed",
        author: operatorAuthor(),
      },
      {
        id: "crm-map",
        level: "agent",
        role: "writer",
        key: "crm-map.md",
        body: "Map the sender to one CRM person.\n",
        kind: "seed",
        author: operatorAuthor(),
      },
    ];
    mixed.roles[0]!.task.body += "\n\n![[guild/desk-rules.md]]";
    mixed.roles[0]!.task.embeds = ["guild/desk-rules.md"];
    mixed.roles[1]!.task.body += "\n\n![[agent/writer/crm-map.md]]\n\nThen note_get guild/desk-rules.md.";
    mixed.roles[1]!.schedules[0]!.instruction += " Read agent/writer/crm-map.md first.";
    mixed.roles[1]!.task.embeds = ["agent/writer/crm-map.md"];
    const mixedId = await importReady(mixed);
    const mixedApply = await applyRecipe(mixedId, "fixture-desk-mixed");
    const mixedAgents = await repo.listAgents(mixedApply.guild_id);
    const mixedReader = mixedAgents.find((row) => row.name === "mixed-reader");
    const mixedWriter = mixedAgents.find((row) => row.name === "mixed-writer");
    assert.ok(mixedReader && mixedWriter);

    // Recipe notes land flat at their owner, and task embeds point at the written files.
    const rulesPath = `org/org_home/guilds/${mixedApply.guild_id}/desk-rules.md`;
    const mapPath = `org/org_home/agents/${mixedWriter.id}/crm-map.md`;
    const mixedReaderTask = await repo.getAgentTask("org_home", String(mixedReader.id));
    const mixedWriterTask = await repo.getAgentTask("org_home", String(mixedWriter.id));
    assert.ok(mixedReaderTask?.content_text.includes(`![[${rulesPath}]]`));
    assert.ok(mixedWriterTask?.content_text.includes(`![[${mapPath}]]`));
    assert.ok(mixedWriterTask?.content_text.includes(`Then note_get ${rulesPath}.`));
    const mixedWriterSchedules = await repo.listSchedules(String(mixedWriter.id));
    assert.ok(mixedWriterSchedules.some((row) => String(row.instruction).includes(`Read ${mapPath} first.`)));
    const noteReader = artifacts.operatorContext("org_home", "user_operator", "operator", {
      guildId: mixedApply.guild_id,
      agentId: String(mixedWriter.id),
    });
    const rulesNote = await artifacts.getByDisplayPath(noteReader, rulesPath);
    assert.equal(rulesNote.row?.key, "desk-rules.md");
    assert.equal(rulesNote.row?.path, "");
    assert.equal(rulesNote.row?.content_text, "Skip thread ids already in seen-ids.\n");
    const mapNote = await artifacts.getByDisplayPath(noteReader, mapPath);
    assert.equal(mapNote.row?.key, "crm-map.md");
    assert.equal(mapNote.row?.path, "");
    const mixedReaderBindings = await repo.listBindingsCovering({
      orgId: "org_home",
      guildId: mixedApply.guild_id,
      agentId: String(mixedReader.id),
    });
    const mixedWriterBindings = await repo.listBindingsCovering({
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
    const sharedBindings = await repo.listBindingsCovering({
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
    const huskAgents = await repo.listAgents(huskApply.guild_id);
    assert.equal(huskAgents.length, 2);
    const huskReader = huskAgents.find((row) => row.name === "husk-reader");
    const huskWriter = huskAgents.find((row) => row.name === "husk-writer");
    assert.ok(huskReader && huskWriter);
    await assertLiveTask(huskApply.guild_id, String(huskReader.id), /Read mail threads/);
    await assertLiveTask(huskApply.guild_id, String(huskWriter.id), /Write CRM rows/);
    for (const member of [huskReader, huskWriter]) {
      const rows = await repo.listSchedules(String(member.id));
      assert.equal(rows.length, 0);
    }
    // The husk's inbox-queue matches the live table column for column, so the
    // guild is granted the existing table and no second one appears.
    const huskTables = await listCollections();
    assert.equal(huskTables.filter((row) => row.name === "inbox-queue").length, 1);
    assert.equal(huskTables.find((row) => row.name === "inbox-queue")?.id, inboxQueue.id);
    assert.deepEqual(huskTables.find((row) => row.name === "inbox-queue")?.columns, inboxQueueColumns());
    const huskAccess = await guildAccess(huskApply.guild_id);
    assert.equal(huskAccess.find((row) => row.name === "inbox-queue")?.mode, "write");
    assert.equal(huskAccess.find((row) => row.name === "seen-ids")?.mode, null);
    const huskGuildBindings = await repo.listBindingsCovering({
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
