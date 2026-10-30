import assert from "node:assert/strict";
import { test } from "node:test";
import { TEST_MODEL } from "../helpers/models.js";
import { CONFIG_KEYS, validateAgentConfig } from "../../src/agents/config.js";
import { loadAccessViewThrough } from "../../src/access/view.js";
import { isPlainRecord } from "../../src/db/json.js";
import { captureGuild,
  portableRoleConfig,
  preferRecipeScope,
  recipeScope,
  type CaptureDeps, type CaptureArtifacts } from "../../src/recipes/capture.js";
import type { Scripts } from "../../src/scripts/catalog.js";
import type { Schedules } from "../../src/schedules/service.js";
import { userRow } from "../helpers/users.js";
import { operatorActor } from "../../src/artifacts/actors.js";
import { rowDisplayPath } from "../../src/artifacts/store.js";
import type { ArtifactRow } from "../../src/db/artifacts.js";
import type { ArtifactLevel } from "../../src/artifacts/types.js";
import { artifactRow, noteRowAt } from "../helpers/artifacts.js";
import { serverRow } from "../helpers/servers.js";

const GUILD = {
  id: "guild_live",
  org_id: "org_home",
  name: "desk",
  about: "Watch mail and write CRM notes.",
  description: "Win the inbox.",
  group_agent_message_limit: 12,
};

const USER = userRow();
const ACTOR = operatorActor({ orgId: GUILD.org_id, actorId: USER.id, actorName: USER.name, guildId: GUILD.id });

const SEEN_MAIL_COLUMNS = [
  { name: "thread_id", type: "text", description: "mail thread id", required: true, unique: true },
];
const LEADS_COLUMNS = [
  { name: "email", type: "text", description: "the lead's email", required: true, unique: true },
  { name: "score", type: "number", description: "fit score", required: false, unique: false },
];

type AccessRow = {
  type: "org" | "guild" | "agent";
  id: string;
  name: string;
  mode: "none" | "read" | "write";
  guild_id: string | null;
  guild_name: string | null;
};

const ORG_ROW: AccessRow = { type: "org", id: "org_home", name: "home", mode: "read", guild_id: null, guild_name: null };

function memberRow(id: string, name: string, mode: AccessRow["mode"]): AccessRow {
  return { type: "agent", id, name, mode, guild_id: "guild_live", guild_name: "desk" };
}

function guildRow(mode: AccessRow["mode"]): AccessRow {
  return { type: "guild", id: "guild_live", name: "desk", mode, guild_id: "guild_live", guild_name: "desk" };
}

const DEFAULT_ACCESS: Record<string, AccessRow[]> = {
  acol_seen: [memberRow("a_scout", "scout", "write")],
  acol_leads: [ORG_ROW, guildRow("read"), memberRow("a_writer", "writer", "write"), memberRow("a_scout", "scout", "read")],
  acol_other: [
    { type: "agent", id: "a_elsewhere", name: "elsewhere", mode: "write", guild_id: "guild_other", guild_name: "other" },
  ],
};

/** An agent's config as the box stores it: every setting, with the fixture's own over the defaults. */
function storedConfig(config: unknown): Record<string, unknown> {
  return { ...validateAgentConfig({ model: TEST_MODEL }), ...(isPlainRecord(config) ? config : {}) };
}

function captureDeps(options: {
  agents?: Array<Record<string, unknown>>;
  task?: string;
  notes?: ArtifactRow[];
  collections?: Array<Record<string, unknown>>;
  bindings?: Array<Record<string, unknown>>;
  access?: Record<string, AccessRow[]>;
  secrets?: Array<Record<string, unknown>>;
  connections?: Array<Record<string, unknown>>;
  servers?: Array<Record<string, unknown>>;
  tools?: Array<Record<string, unknown>>;
  scripts?: Array<Record<string, unknown>>;
  schedules?: Array<Record<string, unknown>>;
  repositories?: Array<Record<string, unknown>>;
} = {}): CaptureDeps {
  const agents = options.agents ?? [
    {
      id: "a_scout",
      name: "scout",
      focus: "Watch",
      wake_triggers: "someone shares a lead",
      avatar_shape: "hex",
      avatar_color: "#11aa22",
      config: {
        model: TEST_MODEL,
        temperature: 0.2,
        max_tokens: 1024,
        max_steps: 8,
        max_tool_calls: 10,
        max_input_tokens: 8000,
        browser: false,
        thinking_level: "none",
        connection_id: "conn_secret",
        sandbox_id: "sbx_local",
      },
    },
    {
      id: "a_writer",
      name: "writer",
      focus: "Write",
      config: { model: TEST_MODEL, browser: true },
    },
  ];
  const accessReads = {
    listBindingsCovering: async () => options.bindings ?? [],
    listMcpConnections: async () => options.connections ?? [],
    listServers: async () => options.servers ?? [],
    connectionTools: async () => options.tools ?? [],
  };
  return {
    db: {
      loadAccessView: (view: Parameters<typeof loadAccessViewThrough>[1]) =>
        loadAccessViewThrough(accessReads as never, view),
      listAgents: async () => agents.map((agent) => ({ ...agent, config: storedConfig(agent.config) })),
      getAgentTask: async (_orgId: string, agentId: string) =>
        agentId === "a_scout"
          ? { content_text: options.task ?? "Ping @scout and keep @user. See ![[org/org_1/guilds/guild_live/playbook.md]]" }
          : { content_text: "Draft the reply." },
      listSchedules: async (agentId: string) =>
        agentId === "a_scout"
          ? (options.schedules ?? [
              {
                cron: "*/15 * * * *",
                wake_window: null,
                description: "Poll",
                instruction: "Ask @writer after @scout.",
              },
            ])
          : [],
      listSecrets: async (_orgId: string, filter: { agentId?: string }) =>
        (options.secrets ?? []).filter(
          (secret) =>
            secret.org_wide ||
            (secret.grants as Array<Record<string, unknown>>).some(
              (grant) => grant.guild_id === GUILD.id || grant.agent_id === filter.agentId,
            ),
        ),
      listGuildRepositories: async () => options.repositories ?? [],
      listMcpCatalogTools: async () => options.tools ?? [],
    } as never,
    artifacts: {
      guildTables: async () =>
        (
          options.collections ?? [
            { id: "acol_seen", name: "seen-mail", purpose: "Dedupe", columns: SEEN_MAIL_COLUMNS },
            { id: "acol_leads", name: "leads", purpose: "Qualified leads", columns: LEADS_COLUMNS },
            { id: "acol_other", name: "other-desk", purpose: "Another guild's table", columns: LEADS_COLUMNS },
          ]
        ).map((collection) => ({
          collection: { scope: "org", guild: null, ...collection },
          access: (options.access ?? DEFAULT_ACCESS)[String(collection.id)] ?? [],
        })),
      notesNamed: async (_actor: unknown, names: ReadonlySet<string>) =>
        (
          options.notes ?? [
            noteRowAt("org/org_1/guilds/guild_live/playbook.md", "Hand off to @writer."),
            noteRowAt("org/org_1/agents/a_scout/memory.md", "lived memory"),
          ]
        )
          .filter((row) => names.has(rowDisplayPath(row)) || names.has(row.key))
          .map((row) => ({ href: rowDisplayPath(row), row, access: (options.access ?? DEFAULT_ACCESS)[row.id] ?? [] })),
    } as unknown as CaptureArtifacts,
    scripts: {
      listForAgent: async (agentId: string) =>
        agentId === "a_scout"
          ? (options.scripts ?? [
              {
                name: "normalize",
                description: "Clean the payload",
                parameters: null,
                source: "export function run() { return @scout; }",
              },
            ])
          : [],
    } as unknown as Scripts,
    schedules: {} as Schedules,
  };
}

test("portable role config carries every setting but the browser mode in the order of the config keys", () => {
  const stored = validateAgentConfig({ model: TEST_MODEL, browser: true });
  const config = portableRoleConfig(stored);
  const left = new Set(["secret_aliases", "browser_optimized", "browser_model"]);
  assert.deepEqual(Object.keys(config), [...CONFIG_KEYS].filter((key) => !key.startsWith("harness") && !left.has(key)));
  assert.equal(config.browser, true);
  assert.equal(config.model, TEST_MODEL);
  assert.equal(config.browser_language, "en-US");
});

test("portable role config leaves out a harness, model and effort left unset, and no secret aliases", () => {
  const config = portableRoleConfig(validateAgentConfig({ model: TEST_MODEL }));
  assert.equal("harness" in config, false);
  assert.equal("harness_model" in config, false);
  assert.equal("harness_effort" in config, false);
  assert.equal("secret_aliases" in config, false);
});

test("portable role config keeps a coding role's harness and its aliases but its harness tokens", () => {
  const stored = validateAgentConfig({
    model: TEST_MODEL,
    coding: true,
    harness: "claude-code",
    harness_model: "opus",
    secret_aliases: { CLAUDE_CODE_OAUTH_TOKEN: "BOB_TOKEN", GH_PAT: "BOB_GH" },
  });
  const config = portableRoleConfig(stored);
  assert.equal(config.harness, "claude-code");
  assert.equal(config.harness_model, "opus");
  assert.deepEqual(config.secret_aliases, { GH_PAT: "BOB_GH" });
});

test("portable role config of a role without coding keeps every secret alias", () => {
  const aliases = { CLAUDE_CODE_OAUTH_TOKEN: "BOB_TOKEN" };
  const config = portableRoleConfig(validateAgentConfig({ model: TEST_MODEL, secret_aliases: aliases }));
  assert.deepEqual(config.secret_aliases, aliases);
});

test("portable role config of an agent on the agent-optimized browser carries the browser without its mode", () => {
  const stored = validateAgentConfig({ model: TEST_MODEL, browser: true, browser_optimized: true, browser_model: TEST_MODEL });
  const config = portableRoleConfig(stored);
  assert.equal(config.browser, true);
  assert.equal("browser_optimized" in config, false);
  assert.equal("browser_model" in config, false);
});

test("recipe scope prefers organisation reuse", () => {
  assert.equal(recipeScope("org"), "org");
  assert.equal(recipeScope("agent"), "agent");
  assert.equal(recipeScope("guild"), "guild");
  assert.equal(preferRecipeScope("agent", "org"), "org");
  assert.equal(preferRecipeScope("org", "guild"), "org");
  assert.equal(preferRecipeScope("agent", "guild"), "guild");
});

test("captureGuild writes a portable snapshot from a live guild", async () => {
  const recipe = await captureGuild(captureDeps(), ACTOR, GUILD, []);
  assert.equal(recipe.format, "guilds.recipe");
  assert.equal(recipe.meta.source.kind, "guild");
  assert.equal(recipe.meta.source.guild_id, "guild_live");
  assert.equal(recipe.meta.description, GUILD.about);
  assert.equal(recipe.guild.objective, "Win the inbox.");
  assert.equal(recipe.roles.length, 2);
  const scout = recipe.roles.find((role) => role.role === "scout");
  assert.ok(scout);
  assert.equal(scout.wake_triggers, "someone shares a lead");
  assert.equal(recipe.roles.find((role) => role.role === "writer")?.wake_triggers, "");
  assert.equal(scout.task.body.includes("@{scout}"), true);
  assert.equal(scout.task.body.includes("@user"), true);
  assert.equal(scout.task.body.includes("![[guild/playbook.md]]"), true);
  assert.equal("connection_id" in scout.config, false);
  assert.equal("sandbox_id" in scout.config, false);
  assert.equal(scout.schedules[0]?.instruction.includes("@{writer}"), true);
  assert.equal(scout.scripts[0]?.source.includes("@{scout}"), true);
  assert.equal(JSON.stringify(recipe).includes("conn_secret"), false);
  assert.equal(JSON.stringify(recipe).includes("lived memory"), false);
  assert.ok(recipe.notes.some((note) => note.key === "playbook.md" && note.body.includes("@{writer}")));
  assert.equal(recipe.version, 2);
  // reached only through an agent's own row: captured with guild read and that agent as writer
  const seenMail = recipe.collections.find((item) => item.name === "seen-mail");
  assert.ok(seenMail);
  assert.equal(seenMail.guild, "read");
  assert.deepEqual(seenMail.writers, ["scout"]);
  assert.deepEqual(seenMail.columns, SEEN_MAIL_COLUMNS);
  // the guild's own row is the guild mode; writers are the members whose own row is write
  const leads = recipe.collections.find((item) => item.name === "leads");
  assert.ok(leads);
  assert.equal(leads.guild, "read");
  assert.deepEqual(leads.writers, ["writer"]);
  assert.deepEqual(leads.columns, LEADS_COLUMNS);
  // a table nobody in the guild can reach is not part of the guild's recipe
  assert.equal(recipe.collections.some((item) => item.name === "other-desk"), false);
  assert.equal(recipe.design.handoffs[0]?.kind, "tagged");
  assert.equal(recipe.design.handoffs[0]?.budget, 12);
  assert.deepEqual(recipe.repositories, []);
});

test("captureGuild takes the better of the organisation's and the guild's rows as the guild mode", async () => {
  const recipe = await captureGuild(
    captureDeps({
      collections: [
        { id: "acol_shared", name: "shared", purpose: "Shared desk", columns: LEADS_COLUMNS },
        { id: "acol_org", name: "org-read", purpose: "Read by the organisation", columns: LEADS_COLUMNS },
        { id: "acol_org_write", name: "org-write", purpose: "Written by the organisation", columns: LEADS_COLUMNS },
        { id: "acol_closed", name: "closed", purpose: "Closed desk", columns: LEADS_COLUMNS },
        { id: "acol_shut", name: "shut", purpose: "Shut to a member", columns: LEADS_COLUMNS },
      ],
      access: {
        acol_shared: [ORG_ROW, guildRow("write"), memberRow("a_scout", "scout", "write")],
        acol_org: [ORG_ROW],
        acol_org_write: [{ ...ORG_ROW, mode: "write" }],
        acol_closed: [],
        acol_shut: [memberRow("a_scout", "scout", "none")],
      },
    }),
    ACTOR,
    GUILD,
    [],
  );
  assert.deepEqual(
    recipe.collections.map((item) => [item.name, item.guild, item.writers]),
    [
      ["shared", "write", []],
      ["org-read", "read", []],
      ["org-write", "write", []],
    ],
  );
});

test("captureGuild carries what each note's access list gives the guild and its roles", async () => {
  const otherGuildRow: AccessRow = {
    type: "guild",
    id: "guild_other",
    name: "other",
    mode: "write",
    guild_id: "guild_other",
    guild_name: "other",
  };
  const note = (id: string, level: ArtifactLevel, key: string, ownerId = "org_1") =>
    artifactRow({ id, level, key, owner_id: ownerId, content_text: "Body." });
  const recipe = await captureGuild(
    captureDeps({
      notes: [
        note("n_org", "org", "glossary.md"),
        note("n_open", "org", "open.md"),
        note("n_guild", "guild", "rules.md", "guild_live"),
        note("n_map", "agent", "map.md", "a_scout"),
        note("n_own", "agent", "own.md", "a_writer"),
      ],
      access: {
        n_org: [ORG_ROW, guildRow("write"), otherGuildRow],
        n_open: [ORG_ROW, memberRow("a_writer", "writer", "write")],
        n_guild: [guildRow("read"), memberRow("a_scout", "scout", "write")],
        n_map: [guildRow("read"), memberRow("a_scout", "scout", "write"), memberRow("a_writer", "writer", "write")],
        n_own: [],
      },
    }),
    ACTOR,
    GUILD,
    ["glossary.md", "open.md", "rules.md", "map.md", "own.md"],
  );
  const access = Object.fromEntries(recipe.notes.map((item) => [item.key, [item.guild ?? null, item.writers]]));
  assert.deepEqual(access, {
    // the guild's write row on an organisation note; another guild's row stays behind
    "glossary.md": ["write", []],
    // the organisation's read row is the guild's mode; a member's own write row makes it a writer
    "open.md": ["read", ["writer"]],
    // a guild note is written by its whole guild
    "rules.md": ["write", []],
    // the owner reaches its note without a row, so only the other member is a writer
    "map.md": ["read", ["writer"]],
    // an agent note nobody else reaches carries no guild mode
    "own.md": [null, []],
  });
  // an agent note is the role of the agent that owns it
  const roles = Object.fromEntries(recipe.notes.map((item) => [item.key, item.role ?? null]));
  assert.deepEqual(roles, { "glossary.md": null, "open.md": null, "rules.md": null, "map.md": "scout", "own.md": "writer" });
});

test("captureGuild lists the guild's repositories by name, without their URLs", async () => {
  const recipe = await captureGuild(
    captureDeps({
      repositories: [
        { name: "api", url: "https://github.com/acme/api", default_branch: "main", connection_id: "conn_gh" },
      ],
    }),
    ACTOR,
    GUILD,
    [],
  );
  assert.deepEqual(recipe.repositories, [{ name: "api", purpose: "" }]);
  assert.equal(JSON.stringify(recipe).includes("acme"), false);
  assert.equal(JSON.stringify(recipe).includes("conn_gh"), false);
});

test("captureGuild records a single-role specialization and org connector scope", async () => {
  const recipe = await captureGuild(
    captureDeps({
      agents: [
        {
          id: "a_scout",
          name: "scout",
          focus: "Watch",
          config: { model: TEST_MODEL, browser: false },
        },
      ],
      servers: [
        serverRow("notion", {
          id: "mcp_notion",
          display_name: "Notion",
          auth: "oauth",
          config: {},
          description: "Workspace",
          setup_hint: "Connect Notion at organisation scope.",
        }),
      ],
      connections: [
        {
          id: "conn_org_notion",
          mcp_server_id: "mcp_notion",
          status: "connected",
          owner_scope: "org",
          account_hint: "ops@example.com",
        },
      ],
      bindings: [
        {
          catalog_kind: "mcp",
          catalog_id: "mcp_notion",
          scope: "org",
          scope_id: "org_home",
          enabled: true,
          connection_id: "conn_org_notion",
        },
      ],
      secrets: [
        {
          id: "sec_tavily",
          name: "TAVILY_KEY",
          description: "Search key",
          org_wide: true,
          grants: [],
        },
      ],
      tools: [{ namespaced_name: "notion.search", name: "notion.search", enabled: true }],
    }),
    ACTOR,
    GUILD,
    [],
  );
  assert.equal(recipe.roles.length, 1);
  assert.equal(recipe.design.specialization[0]?.role, "scout");
  assert.equal(recipe.connections[0]?.server, "notion");
  assert.equal(recipe.connections[0]?.recommended_scope, "org");
  assert.equal(recipe.connections[0]?.setup.includes("organisation"), true);
  assert.equal(JSON.stringify(recipe.connections).includes("conn_org_notion"), false);
  assert.equal(recipe.secrets[0]?.name, "TAVILY_KEY");
  assert.equal(recipe.secrets[0]?.recommended_scope, "org");
});

test("captureGuild takes each secret's scope from how the role gets it", async () => {
  const grant = (target: { guild_id?: string; agent_id?: string }) => ({
    guild_id: target.guild_id ?? null,
    agent_id: target.agent_id ?? null,
    name: "",
    in_guild_id: GUILD.id,
  });
  const recipe = await captureGuild(
    captureDeps({
      secrets: [
        { id: "sec_desk", name: "DESK_KEY", description: "Desk key", org_wide: false, grants: [grant({ guild_id: GUILD.id })] },
        { id: "sec_mail", name: "MAIL_KEY", description: "Mail key", org_wide: false, grants: [grant({ agent_id: "a_writer" })] },
      ],
    }),
    ACTOR,
    GUILD,
    [],
  );
  const desk = recipe.secrets.find((item) => item.name === "DESK_KEY");
  assert.equal(desk?.recommended_scope, "guild");
  assert.deepEqual(desk?.roles, ["scout", "writer"]);
  const mail = recipe.secrets.find((item) => item.name === "MAIL_KEY");
  assert.equal(mail?.recommended_scope, "agent");
  assert.equal(mail?.recommended_role, "writer");
  assert.deepEqual(mail?.roles, ["writer"]);
  assert.equal(JSON.stringify(recipe.secrets).includes("sec_"), false);
});

test("captureGuild leaves a coding role's harness tokens and their aliases behind", async () => {
  const grant = (agentId: string) => ({ guild_id: null, agent_id: agentId, name: "", in_guild_id: GUILD.id });
  const recipe = await captureGuild(
    captureDeps({
      agents: [
        {
          id: "a_coder",
          name: "coder",
          focus: "Code",
          config: {
            model: TEST_MODEL,
            coding: true,
            harness: "claude-code",
            secret_aliases: { CLAUDE_CODE_OAUTH_TOKEN: "CLAUDE_CODE_OAUTH_TOKEN_CODER", DEPLOY_KEY: "PROD_DEPLOY" },
          },
        },
        { id: "a_writer", name: "writer", focus: "Write", config: { model: TEST_MODEL, browser: true } },
      ],
      secrets: [
        { id: "sec_cc", name: "CLAUDE_CODE_OAUTH_TOKEN_CODER", description: "token", org_wide: false, grants: [grant("a_coder")] },
        { id: "sec_cursor", name: "CURSOR_API_KEY", description: "key", org_wide: false, grants: [grant("a_coder")] },
        { id: "sec_deploy", name: "PROD_DEPLOY", description: "deploy", org_wide: false, grants: [grant("a_coder")] },
        { id: "sec_writer", name: "CLAUDE_CODE_OAUTH_TOKEN", description: "writer", org_wide: false, grants: [grant("a_writer")] },
      ],
    }),
    ACTOR,
    GUILD,
    [],
  );
  const coder = recipe.roles.find((role) => role.role === "coder");
  assert.deepEqual(coder?.config.secret_aliases, { DEPLOY_KEY: "PROD_DEPLOY" });
  assert.deepEqual(
    recipe.secrets.map((item) => [item.name, item.roles]),
    [
      ["PROD_DEPLOY", ["coder"]],
      ["CLAUDE_CODE_OAUTH_TOKEN", ["writer"]],
    ],
  );
});

test("captureGuild keeps a coding role's harness model and effort, and leaves them out while unset", async () => {
  const recipe = await captureGuild(
    captureDeps({
      agents: [
        {
          id: "a_coder",
          name: "coder",
          focus: "Code",
          config: { model: TEST_MODEL, coding: true, harness: "codex", harness_model: "gpt-6-luna", harness_effort: "high" },
        },
        { id: "a_plain", name: "plain", focus: "Code", config: { model: TEST_MODEL, coding: true, harness: "codex" } },
      ],
    }),
    ACTOR,
    GUILD,
    [],
  );
  const coder = recipe.roles.find((role) => role.role === "coder");
  assert.equal(coder?.config.harness_model, "gpt-6-luna");
  assert.equal(coder?.config.harness_effort, "high");
  const plain = recipe.roles.find((role) => role.role === "plain");
  assert.equal("harness_model" in (plain?.config ?? {}), false);
  assert.equal("harness_effort" in (plain?.config ?? {}), false);
});

test("captureGuild keeps a random window and labels its design cadence", async () => {
  const window = { timezone: "Europe/Paris", start: "08:00", end: "20:00", max_wakes: 6 };
  const recipe = await captureGuild(
    captureDeps({
      schedules: [{ cron: null, wake_window: window, description: "Wander", instruction: "Look around." }],
    }),
    ACTOR,
    GUILD,
    [],
  );
  const scout = recipe.roles.find((role) => role.schedules.length);
  assert.ok(scout);
  assert.deepEqual(scout.schedules[0]?.window, window);
  assert.equal("cron" in (scout.schedules[0] ?? {}), false);
  const design = recipe.design.routines.find((item) => item.key === scout.schedules[0]?.key);
  assert.equal(design?.cadence, "Up to 6 random wake-ups between 08:00 and 20:00 every day (Europe/Paris)");
});

test("captureGuild refuses an empty roster", async () => {
  await assert.rejects(
    () => captureGuild(captureDeps({ agents: [] }), ACTOR, GUILD, []),
    /no agents/,
  );
});

test("captureGuild records an enabled GitHub login as a connection like any other", async () => {
  const recipe = await captureGuild(
    captureDeps({
      agents: [{ id: "a_triage", name: "triage", focus: "Triage issues", config: { model: TEST_MODEL, browser: false } }],
      servers: [
        serverRow("github", {
          id: "mcp_github",
          display_name: "GitHub",
          auth: "oauth",
          description: "Issues and pull requests",
          setup_hint: "Pick this login's repositories on the GitHub card.",
        }),
      ],
      connections: [
        { id: "conn_gh", mcp_server_id: "mcp_github", status: "connected", owner_scope: "org", account_hint: "acme" },
      ],
      bindings: [
        {
          catalog_kind: "mcp",
          catalog_id: "mcp_github",
          scope: "org",
          scope_id: "org_home",
          enabled: true,
          connection_id: "conn_gh",
        },
      ],
      tools: [{ namespaced_name: "github_list_issues", name: "github_list_issues", enabled: true }],
    }),
    ACTOR,
    GUILD,
    [],
  );
  assert.deepEqual(
    recipe.connections.map((connection) => [connection.server, connection.recommended_scope]),
    [["github", "org"]],
  );
  assert.equal(JSON.stringify(recipe.connections).includes("conn_gh"), false);
});
