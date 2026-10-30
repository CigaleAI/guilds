import assert from "node:assert/strict";
import { test } from "node:test";
import { parseRecipe } from "../../src/recipes/parse.js";
import { linkedInNotionRecipe } from "../helpers/recipe-docs.js";
import {
  hitFromUnknown,
  parseWorkspaceHits,
  pickSearchRemote,
  searchConnectedWorkspace,
} from "../../src/builder/connected.js";
import { builderAskConnection, builderAskOrgConnection, builderAskQuestion, builderSearchConnected } from "../../src/builder/tools.js";
import { MemoryMcpDatabase } from "../helpers/mcp-database.js";
import { connectionRow, serverRow } from "../helpers/servers.js";

function notionServer() {
  return serverRow("notion", { id: "mcp_notion", display_name: "Notion", auth: "oauth", config: {}, setup_hint: "Connect Notion" });
}

function repoStub(options: {
  server?: Record<string, unknown> | null;
  connections?: Array<Record<string, unknown>>;
  tools?: Array<Record<string, unknown>>;
  servers?: Array<Record<string, unknown>>;
}) {
  const server = options.server === undefined ? notionServer() : options.server;
  return {
    async getMcpServer(id: string) {
      return server && String(server.id) === id ? server : null;
    },
    async getMcpServerBySlug(slug: string) {
      return server && String(server.slug) === slug ? server : null;
    },
    async listMcpConnections() {
      return options.connections ?? [];
    },
    async listMcpTools() {
      return options.tools ?? [{ remote_name: "search" }];
    },
    async listServers() {
      return options.servers ?? (server ? [server] : []);
    },
  };
}

/** The pool's database holding the organisation's connected Notion login `conn_1`. */
function notionLogin(): MemoryMcpDatabase {
  const database = new MemoryMcpDatabase();
  database.connections = [connectionRow({ id: "conn_1", mcp_server_id: "mcp_notion" })];
  database.servers = [serverRow("notion", { id: "mcp_notion" })];
  return database;
}

test("parseWorkspaceHits prefers Notion databases and unwraps MCP text", () => {
  const parsed = parseWorkspaceHits(
    JSON.stringify([
      {
        type: "text",
        text: JSON.stringify({
          results: [
            { id: "db1", title: "CRM", object: "database", url: "https://notion.so/crm" },
            { id: "pg1", name: "Notes", object: "page" },
            { id: "db1", title: "CRM duplicate", object: "database" },
          ],
        }),
      },
    ]),
  );
  assert.equal(parsed.hits.length, 2);
  assert.equal(parsed.hits[0]?.kind, "database");
  assert.equal(parsed.hits[0]?.title, "CRM");
  assert.equal(parsed.hits[1]?.kind, "page");
  assert.equal(hitFromUnknown({ title: "no-id" }), null);
  assert.equal(pickSearchRemote([{ remote_name: "fetch" }, { remote_name: "search" }]), "search");
});

test("builder_search_connected asks for an org widget when Notion is missing", async () => {
  const result = (await builderSearchConnected.handler(
    {
      orgId: "org_1",
      capabilities: {} as never,
      db: repoStub({ connections: [] }) as never,
    },
    { query: "CRM" },
  )) as Record<string, unknown>;
  assert.equal(result.connected, false);
  assert.equal(result.error, "not_connected");
  assert.equal(result.recommended_widget, "builder_ask_org_connection");
  assert.match(String(result.storage_hint), /long-lived/);
});

test("builder_search_connected returns databases from the org workspace", async () => {
  const result = await searchConnectedWorkspace(
    {
      db: repoStub({
        connections: [
          {
            id: "conn_1",
            mcp_server_id: "mcp_notion",
            owner_scope: "org",
            status: "connected",
          },
        ],
      }) as never,
      mcp: {
        database: notionLogin(),
        async call() {
          return JSON.stringify({
            results: [{ id: "db1", title: "Projects", object: "database" }],
          });
        },
      },
    },
    "org_1",
    "notion",
    "projects",
  );
  assert.equal(result.connected, true);
  assert.equal(result.databases.length, 1);
  assert.equal(result.databases[0]?.title, "Projects");
});

test("connection widgets emit org-now and any-scope payloads", async () => {
  const repo = repoStub({
    servers: [notionServer()],
  });
  const orgWidget = (await builderAskOrgConnection.handler(
    { orgId: "org_1", capabilities: {} as never, db: repo as never },
    { server_ref: "notion", reason: "Search existing CRM tables." },
  )) as Record<string, unknown>;
  assert.equal(orgWidget.widget, "connect");
  assert.equal(orgWidget.mode, "org");
  assert.equal(orgWidget.connect_now, true);
  assert.equal(orgWidget.await_operator, true);
  assert.deepEqual(orgWidget.allowed_scopes, ["org"]);

  const anyWidget = (await builderAskConnection.handler(
    { orgId: "org_1", capabilities: {} as never, db: repo as never },
    { reason: "Pick the right login.", recommended_scope: "guild" },
  )) as Record<string, unknown>;
  assert.equal(anyWidget.widget, "connect");
  assert.equal(anyWidget.mode, "any");
  assert.equal(anyWidget.apply_later, true);
  assert.equal(anyWidget.await_operator, true);
  assert.equal(anyWidget.recommended_scope, "guild");
  assert.ok(Array.isArray(anyWidget.servers));
});

test("recipe connections keep confirmed Notion tables", () => {
  const recipe = parseRecipe(linkedInNotionRecipe());
  assert.equal(recipe.connections[0]?.resources?.[0]?.kind, "database");
  assert.equal(recipe.connections[0]?.resources?.[0]?.title, "CRM");
});

test("builder_ask_question pauses with option cards", async () => {
  const empty = (await builderAskQuestion.handler({ orgId: "org_1", capabilities: {} as never }, {})) as Record<
    string,
    unknown
  >;
  assert.equal(empty.error, "at least one question is required");

  const widget = (await builderAskQuestion.handler(
    { orgId: "org_1", capabilities: {} as never },
    {
      questions: [
        {
          header: "Cadence",
          question: "How often should the scout wake?",
          options: [
            { label: "Every 15 minutes", description: "Catch new posts quickly." },
            { label: "Hourly", description: "Lower cost." },
          ],
        },
      ],
    },
  )) as Record<string, unknown>;
  assert.equal(widget.widget, "question");
  assert.equal(widget.await_operator, true);
  const questions = widget.questions as Array<Record<string, unknown>>;
  assert.equal(questions.length, 1);
  assert.equal(questions[0]?.header, "Cadence");
  assert.equal((questions[0]?.options as unknown[]).length, 2);
  assert.equal(questions[0]?.allow_other, true);

  const shorthand = (await builderAskQuestion.handler(
    { orgId: "org_1", capabilities: {} as never },
    { question: "Which CRM table?", options: ["Deals", "Companies"] },
  )) as Record<string, unknown>;
  assert.equal(shorthand.widget, "question");
  assert.equal(shorthand.await_operator, true);
  assert.equal((shorthand.questions as unknown[]).length, 1);
});
