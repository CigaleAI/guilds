import assert from "node:assert/strict";
import { test } from "node:test";
import {
  accessSection,
  agentCard,
  blockingSummary,
  cadenceLabel,
  catalogToolNames,
  collectionView,
  connectionCard,
  emptyPendingAccess,
  externalCard,
  findingsByPath,
  grantLabel,
  guildHero,
  handoffChart,
  isOperatorSystem,
  isPendingQuestion,
  isRecipeApproved,
  needsReview,
  noteCard,
  noteSnippet,
  noteTitle,
  operatorActions,
  planMachineMinimum,
  operatorSystemsForRole,
  pendingAccessEdits,
  pendingAccessSummary,
  pendingDesignQuestions,
  planFromRecipe,
  planIssues,
  planSections,
  planTally,
  promptBadge,
  recipeBody,
  reviewLabel,
  roleFindings,
  roleUsesConnection,
  routineView,
  scheduleCadence,
  secretCard,
  systemCards,
  toolKey,
  toolsForConnectionRole,
} from "./planModel";
import type { RecipeDraft, RoleDraft, SystemDraft } from "./planModel";
import type { ApplyPreview, CapabilityServer, RecipeFinding, RecipeRow } from "../../../api/types";

const builder = { by: "builder", reviewed: false } as const;
const operator = { by: "operator", reviewed: true } as const;

function finding(
  code: string,
  path: string,
  severity: RecipeFinding["severity"] = "warning",
  message = `${code} at ${path}`,
): RecipeFinding {
  return { code, severity, path, message };
}

/** Two roles: a browser watcher on a cron schedule that queues posts for a writer using a connector. */
function deskRecipe(): RecipeDraft {
  return {
    meta: { name: "Desk", description: "Watch and write" },
    guild: { name_suggestion: "desk", about: "Watches posts", objective: "Draft replies" },
    roles: [
      {
        role: "watcher",
        name_suggestion: "desk-watcher",
        focus: "Watch the feed",
        config: { model: "fast-model", browser: true },
        task: { body: "Watch the feed and queue posts.", author: builder },
        browser: { required: true, instructions: "", author: builder },
        native_tools: { note_find: true, web_fetch: false },
        grants: { read_guild: true, write_guild: false },
        schedules: [
          {
            key: "watch-feed",
            cron: "*/15 * * * *",
            description: "Check the feed",
            instruction: "Look for new posts",
            author: builder,
          },
        ],
        scripts: [
          { name: "scrape", description: "Scrape a page", source: "print(1)", author: operator },
        ],
      },
      {
        role: "writer",
        focus: "Write replies",
        task: { body: "", author: operator },
      },
    ],
    collections: [
      {
        name: "post-queue",
        purpose: "Posts waiting for the writer",
        columns: [
          { name: "url", type: "text", description: "post url", required: true, unique: true },
          {
            name: "status",
            type: "text",
            description: "",
            required: true,
            values: ["new", "done"],
          },
        ],
        scope: "org",
        guild: "write",
        writers: ["watcher"],
      },
    ],
    notes: [
      {
        id: "style",
        level: "guild",
        key: "style.md",
        body: "# Style\n\nKeep replies short.",
        author: builder,
      },
    ],
    connections: [
      {
        server: "crm",
        auth: "oauth",
        recommended_scope: "guild",
        hint: "Log into the CRM",
        setup: "",
        author: builder,
        roles: { writer: { enabled: true, tools: { crm_write: true, crm_delete: false } } },
      },
    ],
    secrets: [{ name: "API_KEY", description: "Feed API key", recommended_scope: "guild" }],
    external: [{ kind: "dns", title: "", setup: "Add a TXT record", author: builder }],
    design: {
      systems: [],
      routines: [],
      handoffs: [
        { from: "watcher", to: "writer", kind: "collection", collection: "post-queue" },
        { from: "watcher", to: "writer", kind: "tagged", budget: 3 },
        { from: "writer", to: "editor", kind: "tagged" },
      ],
      browser: [{ role: "watcher", site: "feed.example" }],
    },
  };
}

test("isRecipeApproved is true only for ready", () => {
  assert.equal(isRecipeApproved("ready"), true);
  assert.equal(isRecipeApproved("draft"), false);
  assert.equal(isRecipeApproved(null), false);
});

test("recipeBody unwraps a row, keeps a document, and falls back to an empty recipe", () => {
  const doc = deskRecipe();
  assert.equal(recipeBody({ id: "r1", body: doc }), doc);
  assert.equal(recipeBody(doc), doc);
  assert.deepEqual(recipeBody(null), { roles: [], collections: [], connections: [], design: {} });
  assert.equal(planFromRecipe(null).guild.name, "Untitled guild");
});

test("cadenceLabel describes cron expressions without the UTC suffix", () => {
  assert.equal(cadenceLabel("5 * * * *"), "At minute 05 past every hour");
  assert.equal(cadenceLabel("35 */3 * * *"), "At minute 35 past every 3 hours");
  assert.equal(cadenceLabel("*/15 * * * *"), "Every 15 minutes");
  assert.equal(cadenceLabel("0 * * * *"), "Every hour");
  assert.equal(cadenceLabel("* * * * *"), "Every minute");
  assert.equal(cadenceLabel("0 9 * * 1"), "At 09:00 on Monday");
  assert.equal(cadenceLabel("0 9,18 * * *"), "At 09:00 and 18:00 every day");
  assert.equal(cadenceLabel("*/0 * * * *"), "Every 0 minutes");
  assert.equal(cadenceLabel("  every   day "), "every day");
  assert.equal(cadenceLabel(""), "Unspecified cadence");
  assert.equal(cadenceLabel(null), "Unspecified cadence");
});

test("scheduleCadence prefers the wake window over the cron", () => {
  const window = { timezone: "Europe/Paris", start: "09:00", end: "17:00", max_wakes: 2 };
  assert.equal(
    scheduleCadence({ window, cron: "0 * * * *" }),
    "Up to 2 random wake-ups between 09:00 and 17:00 every day (Europe/Paris)",
  );
  assert.equal(scheduleCadence({ window: null, cron: "0 * * * *" }), "Every hour");
});

test("planFromRecipe shapes agents with defaults, enabled tools, grants, and routines", () => {
  const plan = planFromRecipe(deskRecipe());
  const [watcher, writer] = plan.agents;
  assert.ok(watcher && writer);
  assert.equal(watcher.name, "desk-watcher");
  assert.equal(watcher.model, "fast-model");
  assert.equal(watcher.browser, true);
  assert.deepEqual(watcher.nativeTools, ["note_find"]);
  assert.deepEqual(watcher.grants, ["read_guild"]);
  assert.deepEqual(watcher.taskAuthor, builder);
  assert.equal(watcher.routines[0]?.source, "schedule");
  assert.equal(watcher.routines[0]?.window, null);
  assert.equal(writer.name, "writer");
  assert.equal(writer.avatar_shape, "teardrop");
  assert.equal(writer.avatar_color, "#7c5cff");
  assert.equal(writer.model, "");
  assert.equal(writer.browser, false);
  assert.deepEqual(
    plan.routines.map((item) => item.key),
    ["watch-feed"],
  );
  assert.deepEqual(plan.scripts, [
    {
      role: "watcher",
      name: "scrape",
      description: "Scrape a page",
      author: operator,
      source: "print(1)",
    },
  ]);
  assert.deepEqual(plan.counts, {
    agents: 2,
    collections: 1,
    notes: 1,
    scripts: 1,
    routines: 1,
    connections: 1,
    secrets: 1,
  });
  assert.deepEqual(plan.guild, {
    name: "Desk",
    about: "Watches posts",
    objective: "Draft replies",
    groupLimit: 20,
  });
});

test("planFromRecipe reads a plain-text task", () => {
  const role: RoleDraft = { role: "solo", task: "Do the thing." };
  const [agent] = planFromRecipe({ roles: [role] }).agents;
  assert.equal(agent?.task, "Do the thing.");
  assert.equal(agent?.taskAuthor, null);
});

test("planFromRecipe falls back on the guild slug, the created guild, and the meta description", () => {
  const plan = planFromRecipe(
    {
      guild: { name_suggestion: "", about: "", objective: "", group_agent_message_limit: 5 },
      meta: { description: "From meta" },
    },
    { creates: { guild: { name: "created", about: "", objective: "Created goal" } } },
  );
  assert.deepEqual(plan.guild, {
    name: "created",
    about: "From meta",
    objective: "Created goal",
    groupLimit: 5,
  });
});

test("design routines surface only with a five-field cadence and when the role has no schedules", () => {
  const recipe: RecipeDraft = {
    roles: [{ role: "reader" }],
    design: {
      routines: [
        { key: "read-mail", role: "reader", cadence: "*/15 * * * *", dedupe_collection: "seen" },
        { key: "prose", role: "reader", cadence: "every 15 minutes" },
      ],
    },
  };
  const plan = planFromRecipe(recipe);
  assert.deepEqual(plan.routines, [
    {
      role: "reader",
      key: "read-mail",
      cron: "*/15 * * * *",
      window: null,
      description: "read-mail",
      instruction: "",
      author: null,
      source: "design",
      dedupe_collection: "seen",
    },
  ]);
  assert.equal(routineView(plan.routines[0]!).status, "from design");
});

test("apply routines replace the plan's routine list and fill roles without schedules", () => {
  const plan = planFromRecipe(deskRecipe(), {
    creates: {
      routines: [
        {
          role: "watcher",
          key: "watch-feed",
          cron: "*/15 * * * *",
          window: null,
          description: "",
          instruction: "Look",
        },
        {
          role: "writer",
          key: "write",
          cron: "0 9 * * *",
          window: null,
          description: "Write",
          instruction: "",
        },
      ],
    },
  });
  assert.deepEqual(
    plan.routines.map((item) => [item.key, item.source]),
    [
      ["watch-feed", "apply"],
      ["write", "apply"],
    ],
  );
  assert.equal(plan.agents[0]?.routines[0]?.source, "schedule");
  assert.equal(plan.agents[1]?.routines[0]?.source, "apply");
  const row = routineView(plan.routines[1]!);
  assert.equal(row.cadence, "At 09:00 every day");
  assert.equal(row.status, "paused at create");
  assert.equal(routineView(plan.routines[0]!).description, "Look");
});

test("apply agents stand in when the recipe has no roles", () => {
  const plan = planFromRecipe(
    { roles: [] },
    {
      creates: {
        agents: [
          {
            role: "scout",
            name: "scout-1",
            focus: "",
            model: "m",
            browser: true,
            task: "Scout",
            native_tools: ["web_fetch"],
          },
        ],
        routines: [
          {
            role: "scout",
            key: "scan",
            cron: "0 * * * *",
            window: null,
            description: "",
            instruction: "",
          },
        ],
      },
    },
  );
  const [scout] = plan.agents;
  assert.equal(scout?.name, "scout-1");
  assert.equal(scout?.model, "m");
  assert.equal(scout?.browser, true);
  assert.equal(scout?.task, "Scout");
  assert.deepEqual(scout?.nativeTools, ["web_fetch"]);
  assert.equal(scout?.routines[0]?.source, "schedule");
  assert.equal(plan.routines[0]?.source, "apply");
});

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

test("apply secrets replace recipe secrets and reused or skipped ones are not required", () => {
  const plan = planFromRecipe(deskRecipe(), {
    secrets: [
      { name: "API_KEY", dest_name: "FEED_KEY", action: "rename", description: "" },
      { name: "OLD", action: "reuse", recommended_scope: "guild" },
      { name: "SKIP", action: "skip" },
    ],
  });
  const secrets = plan.actions.filter((item) => item.kind === "secret");
  assert.deepEqual(
    secrets.map((item) => [item.title, item.detail, item.required]),
    [
      ["Provide FEED_KEY", "", true],
      ["Provide OLD", "guild", false],
      ["Provide SKIP", "", false],
    ],
  );
  assert.deepEqual(secretCard(plan.secrets[0]!), { name: "FEED_KEY", snippet: "" });
});

test("browser and external actions name the site and fall back on generic titles", () => {
  const plan = planFromRecipe(deskRecipe());
  const browser = plan.actions.find((item) => item.kind === "browser");
  assert.equal(browser?.title, "Take control and log desk-watcher into feed.example");
  assert.match(browser?.detail ?? "", /No native connector/);
  assert.equal(browser?.path, "roles.watcher.browser");
  const external = plan.actions.find((item) => item.kind === "external");
  assert.equal(external?.title, "dns");
  assert.equal(external?.path, "external[0]");
  assert.deepEqual(externalCard(plan.external[0]!), { title: "dns", setup: "Add a TXT record" });
});

test("collections normalise their fields and take the apply decision when given", () => {
  const recipe = deskRecipe();
  recipe.collections = [{ name: "loose", columns: [{ name: "n", values: ["a"] }] }];
  const [loose] = planFromRecipe(recipe).collections;
  assert.deepEqual(loose, {
    name: "loose",
    purpose: "",
    columns: [
      { name: "n", type: "text", description: "", required: false, unique: false, values: ["a"] },
    ],
    scope: "org",
    guild: "read",
    writers: [],
    action: "",
    collection_id: null,
    differences: [],
  });
  const overlaid = planFromRecipe(recipe, {
    creates: {
      collections: [
        {
          name: "queue",
          scope: "guild",
          guild: "write",
          action: "conflict",
          collection_id: "c1",
          differences: ["taken"],
        },
      ],
    },
  });
  assert.equal(overlaid.collections.length, 1);
  assert.equal(overlaid.collections[0]?.action, "conflict");
  assert.equal(overlaid.collections[0]?.collection_id, "c1");
});

test("collectionView labels access, the apply decision, conflicts, and column rules", () => {
  const [queue] = planFromRecipe(deskRecipe()).collections;
  assert.ok(queue);
  const view = collectionView(queue);
  assert.equal(view.chip, null);
  assert.equal(view.access, "guild write · writers: @watcher");
  assert.equal(
    view.meta,
    "Organisation table · every agent in the guild gets write · Own write grant: @watcher",
  );
  assert.deepEqual(
    view.columns.map((column) => [column.typeLabel, column.rules]),
    [
      ["text", ["required", "unique"]],
      ["text: new | done", ["required"]],
    ],
  );
  const conflict = collectionView({
    ...queue,
    scope: "guild",
    writers: [],
    action: "conflict",
    differences: ["taken"],
  });
  assert.deepEqual(conflict.chip, { label: "conflict", tone: "warn" });
  assert.equal(conflict.access, "the guild's own");
  assert.deepEqual(conflict.conflict, {
    headline: "The organisation already has a database named post-queue.",
    differences: ["taken"],
  });
  assert.deepEqual(collectionView({ ...queue, action: "create" }).chip, {
    label: "new table",
    tone: "action",
  });
  assert.equal(collectionView({ ...queue, action: "reuse" }).reuses, true);
});

test("apply notes keep the recipe body matched by id or key", () => {
  const recipe = deskRecipe();
  const plan = planFromRecipe(recipe, {
    creates: {
      notes: [
        { key: "style.md", level: "guild", role: null },
        { key: "new.md", level: "agent", role: "writer" },
      ],
    },
  });
  assert.equal(plan.notes[0]?.body, "# Style\n\nKeep replies short.");
  assert.equal(plan.notes[0]?.id, "style");
  assert.equal(plan.notes[1]?.body, "");
  assert.equal(planFromRecipe(recipe).notes[0], recipe.notes?.[0]);
});

test("noteCard shows the title, owner, first line, and where apply writes the note", () => {
  const card = noteCard({
    key: "style.md",
    level: "guild",
    body: "\n## Style\r\nKeep it short.",
  });
  assert.deepEqual(card, {
    title: "style.md",
    owner: "guild",
    snippet: "Style",
    destination: "guild/style.md",
    body: "\n## Style\r\nKeep it short.",
  });
  const agentNote = noteCard({
    key: "k.md",
    level: "agent",
    role: "writer",
    body: "",
  });
  assert.equal(agentNote.owner, "agent · writer");
  assert.equal(agentNote.destination, "agent/writer/k.md");
  assert.equal(agentNote.snippet, "Empty note");
  assert.equal(noteTitle({ id: "  " }), "note");
  assert.equal(noteSnippet("x".repeat(100)), `${"x".repeat(85)}…`);
});

test("operator and pending-question systems are told apart", () => {
  assert.equal(isOperatorSystem({ resolution: "browser" }), true);
  assert.equal(isOperatorSystem({ kind: "script", resolution: "decision" }), true);
  assert.equal(
    isOperatorSystem({ resolution: "decision", reason: "Operator must take control" }),
    true,
  );
  assert.equal(isOperatorSystem({ resolution: "catalog", reason: "take-control" }), false);
  assert.equal(isPendingQuestion({ resolution: "decision" }), true);
  assert.equal(isPendingQuestion({ resolution: "decision", accepted: true }), false);
  assert.equal(
    isPendingQuestion({ resolution: "refused", reason: "Open question: which CRM?" }),
    true,
  );
  assert.equal(isPendingQuestion({ resolution: "browser" }), false);
  assert.equal(isPendingQuestion({ resolution: "native" }), false);
  const recipe = deskRecipe();
  recipe.design = {
    systems: [
      { name: "a", resolution: "composition" },
      { name: "b", resolution: "catalog" },
    ],
  };
  assert.deepEqual(
    pendingDesignQuestions({ body: recipe }).map((item) => item.name),
    ["a"],
  );
});

test("operator systems attach by explicit roles, by role name in the text, or to browser roles", () => {
  const recipe = deskRecipe();
  const systems: SystemDraft[] = [
    { name: "Scraper", resolution: "script", roles: ["writer"], reason: "Run the scraper" },
    { name: "Portal", resolution: "browser", reason: "The watcher logs into the portal" },
    { name: "Kiosk", resolution: "browser", reason: "" },
    { name: "Board", resolution: "catalog", server: "crm", reason: "" },
    { name: "Wiki", resolution: "native", reason: "Native notes" },
    { name: "Choice", resolution: "decision", reason: "" },
  ];
  recipe.design = { ...recipe.design, systems };
  const plan = planFromRecipe(recipe);
  assert.deepEqual(
    operatorSystemsForRole(plan, "writer").map((item) => item.name),
    ["Scraper"],
  );
  assert.deepEqual(
    operatorSystemsForRole(plan, "watcher").map((item) => item.name),
    ["Portal", "Kiosk"],
  );
  assert.deepEqual(operatorSystemsForRole(plan, " "), []);

  const watcher = operatorActions(plan.agents[0]!, plan);
  assert.equal(
    watcher?.browser?.instructions,
    "Take control of this agent's browser and log into the intended account.",
  );
  assert.deepEqual(watcher?.browser?.notes, ["The watcher logs into the portal", "Kiosk"]);
  assert.deepEqual(watcher?.cards, []);
  const writer = operatorActions(plan.agents[1]!, plan);
  assert.equal(writer?.browser, null);
  assert.deepEqual(writer?.cards, [{ title: "Scraper", text: "Run the scraper" }]);

  assert.deepEqual(
    systemCards(plan).map((item) => [item.name, item.resolution]),
    [["Wiki", "native"]],
  );
  const withoutCrm = { ...plan, connections: [] };
  assert.deepEqual(
    systemCards(withoutCrm).map((item) => item.name),
    ["Board", "Wiki"],
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

test("pending access edits drop tool switches on removed connectors and summarise removals", () => {
  const pending = emptyPendingAccess();
  assert.equal(pendingAccessSummary(pending), null);
  pending.tools.set(toolKey("crm", "writer", "crm_read"), false);
  pending.tools.set(toolKey("crm", "writer", "crm_write"), true);
  pending.tools.set(toolKey("mail", "writer", "mail_send"), false);
  pending.removed.add("mail");
  assert.deepEqual(pendingAccessEdits(pending), [
    { action: "set_tool", server: "crm", role: "writer", tool: "crm_read", enabled: false },
    { action: "set_tool", server: "crm", role: "writer", tool: "crm_write", enabled: true },
    { action: "remove_connection", server: "mail" },
  ]);
  const summary = pendingAccessSummary(pending);
  assert.equal(summary?.removedTools, 1);
  assert.equal(summary?.removedConnectors, 1);
  assert.equal(
    summary?.text,
    "Pending: 1 tool and 1 connector removed. Validate to save and tell the coach.",
  );
  assert.deepEqual(summary?.removed, ["mail"]);
});

test("findings attach by path to roles, the blocking banner, and the issues list", () => {
  const findings = [
    finding("schedule.missing", "roles.writer.schedules"),
    finding("task.derived", "roles.writer.task"),
    finding("task.derived", "roles.writer2.task"),
    finding("review.script", "roles.watcher.scripts.scrape", "info"),
    finding("design.poll_dedupe", "design.routines.read", "error", "needs dedupe"),
    finding("collection.conflict", "collections.queue", "error", "queue exists"),
    finding("design.unused_access", "design.systems.x", "info"),
    finding(
      "access.tool_removed",
      "connections.crm.roles.writer.tools.crm_read",
      "info",
      "removed",
    ),
    finding("harness.credential", "roles.writer.config.harness"),
  ];
  assert.equal(findingsByPath(findings).get("roles.writer.task")?.length, 1);

  const writer = roleFindings(findings, "writer");
  assert.equal(writer.routine?.code, "schedule.missing");
  assert.deepEqual(
    writer.notices.map((item) => item.path),
    ["roles.writer.task"],
  );

  assert.deepEqual(blockingSummary(findings), {
    count: 2,
    label: "2 issues to fix",
    hint: "needs dedupe (+1 more)",
    errors: [findings[4], findings[5]],
  });
  assert.equal(blockingSummary(findings.slice(0, 4)), null);

  const issues = planIssues(findings);
  assert.equal(issues?.title, "System issues");
  assert.deepEqual(
    issues?.items.map((item) => [item.finding.code, item.label]),
    [
      ["design.poll_dedupe", "Needs a decision"],
      ["collection.conflict", "Needs a decision"],
      ["access.tool_removed", "Coach should update prompts"],
    ],
  );
  assert.equal(planIssues([finding("server.unknown", "connections.x", "warning")])?.title, "Notes");
  assert.equal(planIssues(findings.slice(0, 4)), null);
  assert.equal(
    planIssues([finding("machine.full", "machine_id", "error")]),
    null,
    "the machine picker shows machine findings",
  );
});

test("agentCard gathers connectors, metrics, prompt, routines, operator steps, and scripts", () => {
  const plan = planFromRecipe(deskRecipe());
  const findings = [
    finding("schedule.missing", "roles.writer.schedules", "warning", "Add a routine"),
  ];
  const watcher = agentCard(plan.agents[0]!, plan, findings);
  assert.deepEqual(watcher.connectors, []);
  assert.equal(watcher.metrics.connectors.label, "0 connectors");
  assert.equal(watcher.metrics.connectors.empty, true);
  assert.deepEqual(
    watcher.capabilities.map((item) => [item.id, item.label]),
    [["browser", "Browser"]],
  );
  assert.equal(watcher.metrics.routines.label, "1 routine");
  assert.deepEqual(watcher.metrics.routines.entries, [
    { key: "watch-feed", cadence: "Every 15 minutes", description: "Check the feed" },
  ]);
  assert.equal(watcher.metrics.tools.label, "1 tool");
  assert.deepEqual(watcher.metrics.tools.grants, [
    { id: "read_guild", label: "Read guild artifacts" },
  ]);
  assert.deepEqual(watcher.prompt, {
    text: "Watch the feed and queue posts.",
    badge: "31 chars",
    reviewer: null,
  });
  assert.equal(watcher.routines[0]?.cron, "*/15 * * * *");
  assert.equal(watcher.operator?.browser?.notes.length, 0);
  assert.deepEqual(watcher.scripts, [{ name: "scrape", source: "print(1)", reviewer: "operator" }]);

  const writer = agentCard(plan.agents[1]!, plan, findings);
  assert.equal(writer.connectors.length, 1);
  assert.equal(writer.metrics.connectors.label, "1 connector");
  assert.deepEqual(writer.metrics.connectors.entries, [
    { server: "crm", detail: "oauth · guild · tools: crm_write" },
  ]);
  assert.deepEqual(writer.capabilities, []);
  assert.equal(writer.metrics.routines.warning, "Add a routine");
  assert.equal(writer.metrics.routines.label, "0 routines");
  assert.equal(writer.metrics.tools.empty, true);
  assert.deepEqual(writer.prompt, { text: "", badge: "empty", reviewer: "operator" });
  assert.equal(writer.operator, null);
});

test("planTally, planSections, accessSection, and guildHero summarise the plan", () => {
  const plan = planFromRecipe(deskRecipe());
  assert.deepEqual(
    planTally(plan).map((item) => [item.label, item.count, item.section]),
    [
      ["Agents", 2, "agents"],
      ["Connectors", 1, "connectors"],
      ["Routines", 1, "routines"],
      ["Collections", 1, "collections"],
      ["Secrets", 1, "connectors"],
    ],
  );
  assert.deepEqual(accessSection(plan), { count: 2, systems: [], empty: false });
  assert.deepEqual(
    planSections(plan).map((section) => [section.id, section.count, section.open]),
    [
      ["agents", 2, true],
      ["routines", 1, false],
      ["connectors", 2, false],
      ["collections", 1, false],
      ["notes", 1, true],
      ["handoffs", 3, true],
      ["external", 1, true],
    ],
  );

  const empty = planFromRecipe({ roles: [] });
  assert.deepEqual(
    planTally(empty).map((item) => item.label),
    ["Agents"],
  );
  assert.deepEqual(
    planSections(empty).map((section) => [section.id, section.count, section.empty]),
    [
      ["agents", 0, true],
      ["routines", 0, true],
      ["connectors", null, true],
      ["collections", null, true],
      ["notes", null, true],
    ],
  );
  assert.deepEqual(
    planSections(empty, { hideEmpty: true }).map((section) => section.id),
    ["agents"],
  );

  assert.equal(guildHero(plan).goal, "Draft replies");
  const same = planFromRecipe({ guild: { about: "Same", objective: "Same" } });
  assert.deepEqual(guildHero(same), {
    name: "Untitled guild",
    about: "Same",
    groupLimit: 20,
    goal: null,
  });
});

test("handoffChart groups handoffs per pair and falls back on the role for unknown agents", () => {
  const chart = handoffChart(planFromRecipe(deskRecipe()));
  assert.deepEqual(
    chart.nodes.map((node) => [node.role, node.name, Boolean(node.agent)]),
    [
      ["watcher", "desk-watcher", true],
      ["writer", "writer", true],
      ["editor", "editor", false],
    ],
  );
  assert.deepEqual(
    chart.rows.map((row) => [row.from.role, row.to.role, row.vias.map((via) => via.label)]),
    [
      ["watcher", "writer", ["post-queue", "tagged · 3"]],
      ["writer", "editor", ["tagged"]],
    ],
  );
});

test("needsReview is builder work that is still unreviewed", () => {
  assert.equal(needsReview(builder), true);
  assert.equal(needsReview({ by: "builder", reviewed: true }), false);
  assert.equal(needsReview(null), false);
  assert.equal(reviewLabel(builder), null);
  assert.equal(reviewLabel(operator), "operator");
});

test("promptBadge counts trimmed characters and marks empty", () => {
  assert.equal(promptBadge("  hi  "), "2 chars");
  assert.equal(promptBadge(""), "empty");
});

test("grantLabel falls back to the grant id when unknown", () => {
  assert.equal(grantLabel("custom"), "custom");
});

test("the API's row and preview shapes feed the plan directly", () => {
  const body = deskRecipe();
  const row = { id: "r1", status: "ready", body } as unknown as RecipeRow;
  const preview: Pick<ApplyPreview, "creates" | "connections" | "secrets"> = {
    creates: {
      guild: { name: "desk", about: "", objective: "" },
      agents: [],
      collections: [],
      notes: [],
      scripts: [],
      routines: [],
      repositories: [],
      connections: [
        {
          server: "crm",
          auth: "oauth",
          recommended_scope: "guild",
          reusable: [{ id: "conn_1", owner_scope: "org", status: "connected" }],
          action: "reuse",
          connection_id: "conn_1",
          setup: "",
          resources: [],
        },
      ],
      secrets: [
        {
          name: "API_KEY",
          description: "",
          collision: true,
          action: "reuse",
          dest_name: "API_KEY",
          recommended_scope: "guild",
        },
      ],
    },
    connections: [],
    secrets: [],
  };
  const plan = planFromRecipe(row, preview);
  assert.equal(plan.guild.name, "Desk");
  assert.equal(plan.actions.find((item) => item.server === "crm")?.kind, "reuse");
  assert.equal(plan.actions.find((item) => item.kind === "secret")?.required, false);
  assert.equal(plan.routines.length, 1);
});

test("a recipe's repositories become a section and steps to connect GitHub and add each", () => {
  const plan = planFromRecipe({
    ...deskRecipe(),
    roles: [
      {
        role: "dev",
        name_suggestion: "dev",
        focus: "",
        config: { model: "m", coding: true },
        task: { body: "Fix bugs.", embeds: [], author: null },
      },
    ],
    repositories: [{ name: "api", purpose: "The HTTP service." }],
  });
  assert.equal(plan.agents[0]?.coding, true);
  assert.deepEqual(plan.repositories, [{ name: "api", purpose: "The HTTP service." }]);
  assert.deepEqual(
    plan.actions
      .filter((action) => action.kind === "repository" || action.server === "github")
      .map((action) => action.title),
    ["Connect GitHub", "Add the api repository"],
  );
  const sections = planSections(plan, { hideEmpty: true }).map((section) => section.id);
  assert.ok(sections.includes("repositories"));
});

test("a plan needs the largest minimum of its agents, not their sum", () => {
  const plan = planFromRecipe(deskRecipe());
  assert.equal(planMachineMinimum(plan), "1 CPU · 2 GiB");
  assert.equal(planMachineMinimum({ agents: [] }), null);
});

test("a coding agent lists its harness as a capability, pending until one is named", () => {
  const coder = (harness?: string) =>
    planFromRecipe({
      ...deskRecipe(),
      roles: [
        {
          role: "dev",
          name_suggestion: "dev",
          focus: "",
          config: { model: "m", coding: true, ...(harness ? { harness } : {}) },
          task: { body: "", embeds: [], author: null },
        },
      ],
    });
  const named = coder("codex");
  assert.deepEqual(agentCard(named.agents[0]!, named, []).capabilities, [
    {
      id: "coding",
      label: "Coding · Codex",
      hint: ["Code tasks run on Codex."],
      reviewer: null,
      pending: false,
    },
  ]);
  const unnamed = coder();
  const [coding] = agentCard(unnamed.agents[0]!, unnamed, []).capabilities;
  assert.equal(coding?.label, "Coding · no harness yet");
  assert.equal(coding?.pending, true);
});
