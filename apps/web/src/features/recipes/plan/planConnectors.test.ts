import assert from "node:assert/strict";
import { test } from "node:test";
import type { CapabilityServer } from "../../../api/types/builder";
import {
  catalogToolNames,
  connectionCard,
  roleUsesConnection,
  toolsForConnectionRole,
} from "./planConnectors";
import { emptyPendingAccess, toolKey } from "./pendingAccess";
import { planFromRecipe } from "./planModel";
import { builder, deskRecipe } from "./planFixtures";

test("apply connectors merge onto recipe connectors and decide reuse or connect", () => {
  const recipe = deskRecipe();
  const plan = planFromRecipe(recipe, {
    creates: {
      connections: [
        { server: "crm", action: "reuse", connection_id: "conn_1", setup: "" },
        {
          server: "mail",
          action: "create",
          connection_id: null,
          setup: "Connect mail",
          auth: "token",
        },
      ],
    },
  });
  const [crm, mail] = plan.connections;
  assert.equal(crm?.setup, "Log into the CRM");
  assert.equal(crm?.hint, "Log into the CRM");
  assert.deepEqual(crm?.author, builder);
  assert.deepEqual(Object.keys(crm?.roles ?? {}), ["writer"]);
  assert.equal(mail?.author, null);
  assert.deepEqual(
    plan.actions
      .filter((item) => item.server)
      .map((item) => [item.kind, item.title, item.required]),
    [
      ["reuse", "Reuse crm", false],
      ["connect", "Connect mail", true],
    ],
  );
  assert.equal(plan.actions.find((item) => item.server === "mail")?.detail, "Connect mail");
});

test("planFromRecipe does not infer connectors from prompt text", () => {
  const recipe = deskRecipe();
  recipe.connections = [];
  const plan = planFromRecipe(recipe);
  assert.deepEqual(plan.connections, []);
  assert.equal(
    plan.actions.some((item) => item.kind === "connect"),
    false,
  );
});

test("a role uses a connector when it is named and enabled, or when the connector names no role", () => {
  assert.equal(roleUsesConnection({ server: "x" }, "any"), true);
  const scoped = {
    server: "x",
    roles: { a: { enabled: true, tools: {} }, b: { enabled: false, tools: {} } },
  };
  assert.equal(roleUsesConnection(scoped, "a"), true);
  assert.equal(roleUsesConnection(scoped, "b"), false);
  assert.equal(roleUsesConnection(scoped, "c"), false);
});

test("connector tools merge the catalog with recipe switches and pending switches", () => {
  const catalog: CapabilityServer[] = [
    {
      slug: "crm",
      display_name: "CRM",
      auth: "oauth",
      oauth_strategy: "dynamic",
      oauth_setup_state: "dynamic",
      description: "",
      limitations: null,
      setup_hint: null,
      enabled: true,
      tool_prefix: "crm",
      transport: "http",
      connection_state: "connected",
      reusable_scopes: ["org"],
      tools: [
        { namespaced_name: "crm_read", default_enabled: true },
        { namespaced_name: "crm_write", default_enabled: true },
      ],
      searchable: false,
      search_via: null,
    },
  ];
  const plan = planFromRecipe(deskRecipe());
  const crm = plan.connections[0]!;
  assert.deepEqual(toolsForConnectionRole(crm, "writer", catalog), [
    { name: "crm_delete", enabled: false },
    { name: "crm_read", enabled: true },
    { name: "crm_write", enabled: true },
  ]);
  const pending = emptyPendingAccess();
  pending.tools.set(toolKey("crm", "writer", "crm_read"), false);
  pending.tools.set(toolKey("crm", "writer", "crm_delete"), true);
  assert.deepEqual(
    toolsForConnectionRole(crm, "writer", catalog, pending).map((tool) => tool.enabled),
    [true, false, true],
  );
  assert.deepEqual(
    catalogToolNames(
      [{ server: "mail", tools: [{ remote_name: " read " }, { name: "send" }, {}] }],
      "mail",
    ),
    ["read", "send"],
  );

  const card = connectionCard(crm, plan, catalog, pending);
  assert.equal(card.reused, false);
  assert.deepEqual(card.chip, { label: "connect at apply", tone: "action" });
  assert.equal(card.snippet, "Log into the CRM");
  assert.equal(card.meta, "oauth · guild · writer (crm_write)");
  assert.equal(card.reviewer, null);
  assert.deepEqual(
    card.tools.groups.map((group) => [group.role, group.title]),
    [["writer", "Tools"]],
  );
  assert.equal(card.tools.empty, null);

  const bare = connectionCard(
    {
      server: "mail",
      recommended_scope: "org",
      resources: [
        { id: "db1", use: "Inbox" },
        { kind: "page", title: "Home" },
      ],
    },
    plan,
    catalog,
  );
  assert.deepEqual(bare.chip, { label: "org login", tone: "action" });
  assert.equal(bare.snippet, "Used by: desk-watcher, writer");
  assert.equal(bare.meta, "oauth · org · desk-watcher, writer");
  assert.deepEqual(bare.resources, ["table: db1 — Inbox", "page: Home"]);
  assert.equal(
    bare.tools.empty,
    "Catalog tools will appear here once this connector is published.",
  );
  const reused = connectionCard(
    {
      server: "crm",
      action: "reuse",
      connection_id: "c1",
      roles: { nobody: { enabled: true, tools: {} } },
    },
    plan,
    catalog,
  );
  assert.deepEqual(reused.chip, { label: "reuse login", tone: "ok" });
  assert.equal(reused.meta, "oauth · guild · all roles");
  assert.equal(reused.tools.empty, "No tools listed for assigned roles.");
});
