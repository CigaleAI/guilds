import assert from "node:assert/strict";
import { test } from "node:test";
import { TEST_MODEL } from "../helpers/models.js";
import {
  captureGuild,
  portableRoleConfig,
  preferRecipeScope,
  recipeScope,
  type CaptureDeps,
} from "../../src/recipes/capture.js";
import type { ArtifactStore } from "../../src/artifacts/index.js";
import type { Repositories } from "../../src/db/repositories.js";
import type { Scripts } from "../../src/scripts/catalog.js";
import type { Schedules } from "../../src/schedules/service.js";

const GUILD = {
  id: "guild_live",
  org_id: "org_home",
  name: "desk",
  about: "Watch mail and write CRM notes.",
  description: "Win the inbox.",
  group_agent_message_limit: 12,
};

const USER = { id: "user_operator", name: "operator" };

const SEEN_MAIL_COLUMNS = [
  { name: "thread_id", type: "text", description: "mail thread id", required: true, unique: true },
];
const LEADS_COLUMNS = [
  { name: "email", type: "text", description: "the lead's email", required: true, unique: true },
  { name: "score", type: "number", description: "fit score", required: false, unique: false },
];

function captureDeps(options: {
  agents?: Array<Record<string, unknown>>;
  task?: string;
  notes?: Array<Record<string, unknown>>;
  collections?: Array<Record<string, unknown>>;
  bindings?: Array<Record<string, unknown>>;
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
  return {
    repo: {
      listAgents: async () => agents,
      getAgentTask: async (_orgId: string, agentId: string) =>
        agentId === "a_scout"
          ? { content_text: options.task ?? "Ping @scout and keep @user. See ![[guild/playbook.md]]" }
          : { content_text: "Draft the reply." },
      listSchedules: async (agentId: string) =>
        agentId === "a_scout"
          ? (options.schedules ?? [
              { cron: "*/15 * * * *", description: "Poll", instruction: "Ask @writer after @scout." },
            ])
          : [],
      listBindingsCovering: async () => options.bindings ?? [],
      listSecrets: async (_orgId: string, filter: { agentId?: string }) =>
        (options.secrets ?? []).filter(
          (secret) =>
            secret.org_wide ||
            (secret.grants as Array<Record<string, unknown>>).some(
              (grant) => grant.guild_id === GUILD.id || grant.agent_id === filter.agentId,
            ),
        ),
      listMcpConnections: async () => options.connections ?? [],
      listGuildRepositories: async () => options.repositories ?? [],
      listMcpServers: async () => options.servers ?? [],
      listMcpTools: async () => options.tools ?? [],
      listMcpCatalogTools: async () => options.tools ?? [],
    } as unknown as Repositories,
    artifacts: {
      getByDisplayPath: async () => ({ row: { content_text: "Win the inbox." }, tombstone: false }),
      listCollections: async () =>
        options.collections ?? [
          { id: "acol_seen", name: "seen-mail", purpose: "Dedupe", columns: SEEN_MAIL_COLUMNS },
          { id: "acol_leads", name: "leads", purpose: "Qualified leads", columns: LEADS_COLUMNS },
          { id: "acol_other", name: "other-desk", purpose: "Another guild's table", columns: LEADS_COLUMNS },
        ],
      accessForGuild: async () => [
        { collection_id: "acol_seen", name: "seen-mail", purpose: "Dedupe", mode: null },
        { collection_id: "acol_leads", name: "leads", purpose: "Qualified leads", mode: "read" },
        { collection_id: "acol_other", name: "other-desk", purpose: "Another guild's table", mode: null },
      ],
      listAccess: async (_actor: unknown, collectionId: string) => ({
        guilds: [],
        agents:
          collectionId === "acol_seen"
            ? [
                {
                  id: "a_scout",
                  name: "scout",
                  guild_id: "guild_live",
                  guild_name: "desk",
                  guild_mode: null,
                  agent_mode: "write",
                  effective: "write",
                },
              ]
            : collectionId === "acol_leads"
              ? [
                  {
                    id: "a_writer",
                    name: "writer",
                    guild_id: "guild_live",
                    guild_name: "desk",
                    guild_mode: "read",
                    agent_mode: "write",
                    effective: "write",
                  },
                  {
                    id: "a_scout",
                    name: "scout",
                    guild_id: "guild_live",
                    guild_name: "desk",
                    guild_mode: "read",
                    agent_mode: null,
                    effective: "read",
                  },
                ]
              : [
                  {
                    id: "a_elsewhere",
                    name: "elsewhere",
                    guild_id: "guild_other",
                    guild_name: "other",
                    guild_mode: null,
                    agent_mode: "write",
                    effective: "write",
                  },
                ],
      }),
      listEmbeddableNotes: async () =>
        options.notes ?? [
          {
            display_path: "guild/playbook.md",
            key: "playbook.md",
            kind: "note",
            level: "guild",
            content: "Hand off to @writer.",
          },
          {
            display_path: "agent/a_scout/memory.md",
            key: "memory.md",
            kind: "note",
            level: "agent",
            owner_id: "a_scout",
            content: "lived memory",
          },
        ],
    } as unknown as ArtifactStore,
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

test("portable role config keeps generation keys and drops local ids", () => {
  const config = portableRoleConfig(
    { model: TEST_MODEL, browser: true, connection_id: "conn_1", sandbox_id: "sbx" },
    true,
  );
  assert.equal(config.browser, true);
  assert.equal(config.model, TEST_MODEL);
  assert.equal(config.browser_language, "en-US");
  assert.equal("connection_id" in config, false);
  assert.equal("sandbox_id" in config, false);
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
  const recipe = await captureGuild(captureDeps(), { guild: GUILD, user: USER });
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
  // reached only through an agent's own grant: captured with guild read and that agent as writer
  const seenMail = recipe.collections.find((item) => item.name === "seen-mail");
  assert.ok(seenMail);
  assert.equal(seenMail.guild, "read");
  assert.deepEqual(seenMail.writers, ["scout"]);
  assert.deepEqual(seenMail.columns, SEEN_MAIL_COLUMNS);
  // the guild's own grant is the guild mode; writers are the members with their own write grant
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

test("captureGuild lists the guild's repositories by name, without their URLs", async () => {
  const recipe = await captureGuild(
    captureDeps({
      repositories: [
        { name: "api", url: "https://github.com/acme/api", default_branch: "main", connection_id: "conn_gh" },
      ],
    }),
    { guild: GUILD, user: USER },
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
        {
          id: "mcp_notion",
          slug: "notion",
          display_name: "Notion",
          publication_state: "published",
          auth: "oauth",
          description: "Workspace",
          setup_hint: "Connect Notion at organisation scope.",
        },
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
    { guild: GUILD, user: USER },
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
    { guild: GUILD, user: USER },
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

test("captureGuild keeps a random window and labels its design cadence", async () => {
  const window = { timezone: "Europe/Paris", start: "08:00", end: "20:00", max_wakes: 6 };
  const recipe = await captureGuild(
    captureDeps({
      schedules: [{ cron: null, wake_window: window, description: "Wander", instruction: "Look around." }],
    }),
    { guild: GUILD, user: USER },
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
    () => captureGuild(captureDeps({ agents: [] }), { guild: GUILD, user: USER }),
    /no agents/,
  );
});
