import { Type } from "@sinclair/typebox";
import { getMcpServerBySlug } from "../connectors/servers.js";
import { HARNESSES, type AgentConfig } from "../db/schema/index.js";
import { decode } from "../lib/decode.js";
import { newId } from "../lib/ids.js";
import { collectTaskEmbeds } from "../artifacts/embeds.js";
import { guildTables, notesNamed } from "../artifacts/service.js";
import type { ArtifactActor } from "../artifacts/types.js";
import type { ArtifactStore } from "../artifacts/store.js";
import type { ArtifactRow } from "../db/artifacts.js";
import { accessViewDatabase, loadAccessView } from "../access/view.js";
import type { Scripts } from "../scripts/catalog.js";
import type { Schedules } from "../schedules/service.js";
import { rowTiming } from "../schedules/timing.js";
import { describeWindow } from "../schedules/window.js";
import { HARNESS_INFO, harnessSecretSource } from "../coding/harnesses.js";
import { emptyRecipe } from "./minimal.js";
import { parseRecipe } from "./parse.js";
import {
  operatorAuthor,
  RECIPE_HINT_MAX,
  type RecipeConnection,
  type RecipeDocument,
  type RecipeNote,
  type RecipeRole,
  type RecipeSecret,
} from "./schema.js";
import { recipeNotePath, rewriteGuildTextToRecipeRefs } from "./rewrite.js";
import { RecipeError } from "./errors.js";
import { capturedNoteAccess, capturedTableAccess, type CapturedGuild } from "./access.js";
import { exportManifest } from "../mcp/catalog.js";
import { getAgentTask, listAgents, type GuildAgentRow } from "../db/agents.js";
import { listSchedules } from "../db/schedules.js";
import { listSecrets, type SecretRow } from "../db/secrets.js";
import { listGuildRepositories, type GuildRow } from "../db/guilds.js";
import { bindQuery, type Queryable } from "../db/pg.js";

/** The db/ functions a guild is captured into a recipe through, and the access view it reads, on `db`. */
export function captureDatabase(db: Queryable) {
  return {
    ...accessViewDatabase(db),
    listAgents: bindQuery(db, listAgents),
    getAgentTask: bindQuery(db, getAgentTask),
    listSchedules: bindQuery(db, listSchedules),
    getMcpServerBySlug: bindQuery(db, getMcpServerBySlug),
    listSecrets: bindQuery(db, listSecrets),
    listGuildRepositories: bindQuery(db, listGuildRepositories),
  };
}

/** The artifact functions a capture reads notes, tables, and their access lists through, on `store`. */
export function captureArtifacts(store: ArtifactStore) {
  return {
    guildTables: bindQuery(store, guildTables),
    notesNamed: bindQuery(store, notesNamed),
  };
}

export type CaptureArtifacts = ReturnType<typeof captureArtifacts>;

export type CaptureDeps = {
  db: ReturnType<typeof captureDatabase>;
  artifacts: CaptureArtifacts;
  scripts: Scripts;
  schedules: Schedules;
};

export function recipeScope(value: unknown): "org" | "guild" | "agent" {
  return value === "org" || value === "agent" ? value : "guild";
}

export function preferRecipeScope(
  current: "org" | "guild" | "agent" | undefined,
  next: "org" | "guild" | "agent",
): "org" | "guild" | "agent" {
  if (current === "org" || next === "org") return "org";
  if (current === "guild" || next === "guild") return "guild";
  return next;
}

/** How an agent of `guildId` gets a secret: organisation-wide, through its guild, or granted itself. */
function secretRecipeScope(secret: SecretRow, guildId: string): "org" | "guild" | "agent" {
  if (secret.org_wide) return "org";
  return secret.grants.some((grant) => grant.guild_id === guildId) ? "guild" : "agent";
}

/** The variables the harnesses read their subscription tokens from. */
const HARNESS_TOKEN_VARIABLES = new Set(
  HARNESSES.flatMap((harness) => HARNESS_INFO[harness].secret ?? []),
);

/**
 * The secrets a coding agent's harnesses read their subscription tokens from. They are the
 * operator's own subscription, so a recipe leaves them out: the applying operator sets one up
 * for the harness they pick.
 */
function harnessTokenSecrets(config: AgentConfig): Set<string> {
  if (!config.coding) return new Set();
  return new Set(HARNESSES.flatMap((harness) => harnessSecretSource(harness, config.secret_aliases) ?? []));
}

/** The role's secret aliases a recipe carries: a coding role's harness token aliases stay behind. */
function portableSecretAliases(config: AgentConfig): Record<string, string> {
  if (!config.coding) return config.secret_aliases;
  return Object.fromEntries(
    Object.entries(config.secret_aliases).filter(([variable]) => !HARNESS_TOKEN_VARIABLES.has(variable)),
  );
}

function clippedHint(value: string | null | undefined): string {
  return (value ?? "").slice(0, RECIPE_HINT_MAX);
}

/**
 * The config a role carries for an agent: its settings, in the order of `CONFIG_KEYS`. A harness,
 * harness model or harness effort left unset, and secret aliases a recipe carries none of, leave
 * their key out; apply settles them.
 */
export function portableRoleConfig(config: AgentConfig): RecipeRole["config"] {
  const aliases = portableSecretAliases(config);
  return {
    model: config.model,
    temperature: config.temperature,
    max_tokens: config.max_tokens,
    max_steps: config.max_steps,
    max_tool_calls: config.max_tool_calls,
    max_input_tokens: config.max_input_tokens,
    keep_tool_result_generations: config.keep_tool_result_generations,
    max_scripts: config.max_scripts,
    max_workspace_mib: config.max_workspace_mib,
    browser: config.browser,
    browser_language: config.browser_language,
    coding: config.coding,
    ...(config.harness === null ? {} : { harness: config.harness }),
    ...(config.harness_model === null ? {} : { harness_model: config.harness_model }),
    ...(config.harness_effort === null ? {} : { harness_effort: config.harness_effort }),
    ...(Object.keys(aliases).length ? { secret_aliases: aliases } : {}),
    scripting: config.scripting,
    memory: config.memory,
    thinking_level: config.thinking_level,
  };
}

/** A tool as the access view lists it: its name, and whether the agent has it on. */
const ToolView = Type.Object({ name: Type.String(), enabled: Type.Boolean() });

/** A server as an agent's access view lists it, with the fields a recipe connection is captured from. */
const ServerView = Type.Object({
  slug: Type.String(),
  enabled: Type.Boolean(),
  auth: Type.Optional(Type.Unknown()),
  description: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  setup_hint: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  org_owned: Type.Optional(Type.Boolean()),
  source_scope: Type.Optional(Type.Unknown()),
  connection_owner_scope: Type.Optional(Type.Unknown()),
  tools: Type.Optional(Type.Array(ToolView)),
});

type ServerView = (typeof ServerView)["static"];

/** The parts of an agent's access view a capture reads: its native tools and its servers. */
const AgentAccess = Type.Object({
  tools: Type.Array(ToolView),
  mcp: Type.Optional(Type.Array(ServerView)),
});

type AgentAccess = (typeof AgentAccess)["static"];

function uncapturable(problem: string): RecipeError {
  return new RecipeError(`the guild cannot be captured: unexpected view at ${problem}`);
}

/** The guild fields a capture reads. */
export type CapturedGuildRow = Pick<GuildRow, "id" | "org_id" | "name" | "about" | "description" | "group_agent_message_limit">;

/** What a capture works from, and the recipe it writes into while it walks the guild. */
type Capture = {
  deps: CaptureDeps;
  recipe: RecipeDocument;
  orgId: string;
  guildId: string;
  actor: ArtifactActor;
  agents: GuildAgentRow[];
  captured: CapturedGuild;
};

/** The recipe a guild starts from: its name, about and objective, and its group message limit. */
function guildRecipe(guild: CapturedGuildRow): RecipeDocument {
  const recipe = emptyRecipe({ name: guild.name, source: { kind: "guild", guild_id: guild.id } });
  recipe.meta.name = guild.name;
  recipe.meta.description = guild.about;
  recipe.guild.name_suggestion = guild.name;
  recipe.guild.about = guild.about;
  recipe.guild.group_agent_message_limit = guild.group_agent_message_limit;
  recipe.guild.objective = guild.description;
  return recipe;
}

/**
 * Every table the guild reaches: its own, and the organisation tables its organisation's row,
 * its own row, or one of its agents' rows reaches.
 */
async function captureCollections(capture: Capture): Promise<void> {
  const { deps, recipe, actor, guildId } = capture;
  for (const { collection, access } of await deps.artifacts.guildTables(actor, guildId)) {
    const table = { name: collection.name, purpose: collection.purpose, columns: collection.columns };
    if (collection.scope === "guild") {
      recipe.collections.push({ ...table, scope: "guild", guild: "write", writers: [] });
      continue;
    }
    const reach = capturedTableAccess(access, capture.captured);
    if (reach !== null) {
      recipe.collections.push({ ...table, scope: "org", ...reach });
    }
  }
}

/** A role's scripts, as its agent holds them. */
async function captureScripts(capture: Capture, agentId: string): Promise<RecipeRole["scripts"]> {
  return (await capture.deps.scripts.listForAgent(agentId)).map((script) => ({
    name: script.name,
    description: script.description,
    parameters: script.parameters,
    source: script.source,
    secrets: [],
    author: operatorAuthor(),
  }));
}

/** A role's routines, keyed by the role and their order. */
async function captureSchedules(capture: Capture, agentId: string, role: string): Promise<RecipeRole["schedules"]> {
  return (await capture.deps.db.listSchedules(agentId)).map((row, index) => {
    const timing = rowTiming(row);
    return {
      key: `${role}-${index + 1}`,
      ...(timing.window === null ? { cron: timing.cron } : { window: timing.window }),
      description: row.description,
      instruction: row.instruction,
      author: operatorAuthor(),
    };
  });
}

/** The role an agent becomes: its config made portable, its task, scripts, routines and native tools. */
async function captureRole(capture: Capture, agent: GuildAgentRow, access: AgentAccess): Promise<RecipeRole> {
  const role = agent.name;
  const { config } = agent;
  const taskBody = (await capture.deps.db.getAgentTask(capture.orgId, agent.id))?.content_text ?? "";
  const scripts = await captureScripts(capture, agent.id);
  const browserRequired = config.browser;
  const portable = portableRoleConfig({ ...config, max_scripts: Math.max(config.max_scripts, scripts.length) });
  return {
    role,
    name_suggestion: role,
    focus: agent.focus,
    wake_triggers: agent.wake_triggers,
    avatar_shape: agent.avatar_shape,
    avatar_color: agent.avatar_color,
    config: portable,
    task: { body: taskBody, embeds: collectTaskEmbeds(taskBody), author: operatorAuthor() },
    scripts,
    schedules: await captureSchedules(capture, agent.id, role),
    native_tools: Object.fromEntries(access.tools.map((item) => [item.name, item.enabled])),
    browser: { required: browserRequired, instructions: "", author: operatorAuthor() },
  };
}

/** The auth a server's connection takes, as the access view names it; token when it names none. */
function connectionAuth(value: unknown): RecipeConnection["auth"] {
  return value === "oauth" || value === "none" || value === "token" ? value : "token";
}

type RecipeScope = "org" | "guild" | "agent";

/** Settles a scope several roles share: the widest one, naming a role only while it stays an agent's. */
function widenScope(entry: { recommended_scope: RecipeScope; recommended_role?: string }, scope: RecipeScope, role: string): void {
  entry.recommended_scope = preferRecipeScope(entry.recommended_scope, scope);
  if (entry.recommended_scope !== "agent") {
    delete entry.recommended_role;
  } else if (!entry.recommended_role) {
    entry.recommended_role = role;
  }
}

/** The scope a role reaches a server at: its connection's owner, else the binding that turns it on. */
function serverScope(server: ServerView): RecipeScope {
  return recipeScope(server.connection_owner_scope ?? server.source_scope);
}

/** A recipe connection for a server, as the first role that has it reaches it. */
async function newConnection(capture: Capture, server: ServerView, role: string): Promise<RecipeConnection> {
  const scope = serverScope(server);
  const connection: RecipeConnection = {
    server: server.slug,
    auth: connectionAuth(server.auth),
    recommended_scope: scope,
    hint: clippedHint(server.description),
    setup: server.setup_hint ?? "",
    author: operatorAuthor(),
    roles: {},
  };
  if (scope === "agent") {
    connection.recommended_role = role;
  }
  // An organisation's own server travels whole: the box applying the recipe may lack it.
  const row = server.org_owned ? await capture.deps.db.getMcpServerBySlug(server.slug, capture.orgId) : null;
  if (row && row.owner_org_id === capture.orgId) {
    connection.manifest = exportManifest(row);
  }
  return connection;
}

/** Joins a further role's server to its recipe connection: the wider scope, and the setup and hint it lacked. */
function joinConnection(connection: RecipeConnection, server: ServerView, role: string): void {
  widenScope(connection, serverScope(server), role);
  if (!connection.setup && server.setup_hint) {
    connection.setup = server.setup_hint;
  }
  if (!connection.hint && server.description) {
    connection.hint = clippedHint(server.description);
  }
}

/** The servers a role has on, as recipe connections with the role's tool overlay. */
async function captureConnections(capture: Capture, servers: ServerView[], role: string): Promise<void> {
  for (const server of servers.filter((item) => item.enabled)) {
    let connection = capture.recipe.connections.find((item) => item.server === server.slug);
    if (connection) {
      joinConnection(connection, server, role);
    } else {
      connection = await newConnection(capture, server, role);
      capture.recipe.connections.push(connection);
    }
    const tools = Object.fromEntries((server.tools ?? []).map((tool) => [tool.name, tool.enabled]));
    connection.roles[role] = { enabled: server.enabled, tools };
  }
}

/** Adds a role to the recipe secret of `secret`'s name, created with the first role that gets it. */
function captureSecret(capture: Capture, secret: SecretRow, role: string): void {
  const scope = secretRecipeScope(secret, capture.guildId);
  let entry: RecipeSecret | undefined = capture.recipe.secrets.find((item) => item.name === secret.name);
  if (entry) {
    widenScope(entry, scope, role);
  } else {
    entry = { name: secret.name, description: secret.description, recommended_scope: scope, roles: [] };
    if (scope === "agent") {
      entry.recommended_role = role;
    }
    capture.recipe.secrets.push(entry);
  }
  if (!entry.roles.includes(role)) {
    entry.roles.push(role);
  }
}

/** The secrets an agent gets, but a coding agent's harness tokens: those are the operator's own subscription. */
async function captureSecrets(capture: Capture, agent: GuildAgentRow): Promise<void> {
  const harnessTokens = harnessTokenSecrets(agent.config);
  for (const secret of await capture.deps.db.listSecrets(capture.orgId, { agentId: agent.id })) {
    if (!harnessTokens.has(secret.name)) {
      captureSecret(capture, secret, agent.name);
    }
  }
}

/** An agent as a role, with the connections and secrets it reaches. */
async function captureAgent(capture: Capture, agent: GuildAgentRow): Promise<void> {
  const view = await loadAccessView(capture.deps.db, {
    orgId: capture.orgId,
    guildId: capture.guildId,
    agentId: agent.id,
    viewScope: "agent",
  });
  const access = decode(AgentAccess, view, uncapturable);
  capture.recipe.roles.push(await captureRole(capture, agent, access));
  await captureConnections(capture, access.mcp ?? [], agent.name);
  await captureSecrets(capture, agent);
}

/** Repositories travel by name only: their URLs and connections stay with the guild. */
async function captureRepositories(capture: Capture): Promise<void> {
  const rows = await capture.deps.db.listGuildRepositories(capture.guildId);
  capture.recipe.repositories = rows.map((row) => ({ name: row.name, purpose: "" }));
}

/** The seed note a live note becomes, with the role of the agent that owns an agent note. */
function seedNote(capture: Capture, note: ArtifactRow): RecipeNote {
  const seed: RecipeNote = {
    id: newId("nte").slice(0, 16),
    level: note.level,
    key: note.key,
    body: note.content_text ?? "",
    kind: "seed",
    author: operatorAuthor(),
    writers: [],
  };
  const owner = note.level === "agent" ? capture.agents.find((agent) => agent.id === note.owner_id) : undefined;
  if (owner) {
    seed.role = owner.name;
  }
  return seed;
}

/**
 * The notes the operator includes and the roles' tasks embed, as seed notes with their access;
 * an agent's Memory stays behind. Returns each captured note's recipe path by its display path.
 */
async function captureNotes(capture: Capture, includeNotes: string[]): Promise<Map<string, string>> {
  const { deps, actor } = capture;
  const include = new Set([...includeNotes, ...capture.recipe.roles.flatMap((role) => role.task.embeds)]);
  const hrefToNoteId = new Map<string, string>();
  for (const note of await deps.artifacts.notesNamed(actor, include)) {
    if (note.row.key === "memory.md" || note.row.kind !== "note") {
      continue;
    }
    const seed = seedNote(capture, note.row);
    Object.assign(seed, capturedNoteAccess(note.access, seed, capture.captured));
    hrefToNoteId.set(note.href, recipeNotePath(seed));
    capture.recipe.notes.push(seed);
  }
  return hrefToNoteId;
}

/** Points the recipe's text at its own roles and notes: tasks, routines, scripts and note bodies. */
function rewriteRefs(recipe: RecipeDocument, refs: { nameToRole: Map<string, string>; hrefToNoteId: Map<string, string> }): void {
  const rewrite = (text: string) => rewriteGuildTextToRecipeRefs(text, refs.nameToRole, refs.hrefToNoteId);
  for (const role of recipe.roles) {
    role.task.body = rewrite(role.task.body);
    role.task.embeds = role.task.embeds.map((href) => refs.hrefToNoteId.get(href) ?? href);
    for (const schedule of role.schedules) {
      schedule.instruction = rewrite(schedule.instruction);
    }
    for (const script of role.scripts) {
      script.source = rewrite(script.source);
    }
  }
  for (const note of recipe.notes) {
    note.body = rewrite(note.body);
  }
}

/** A guild of one role already runs as that role: the design records the specialization as accepted. */
function designSpecialization(recipe: RecipeDocument): void {
  const only = recipe.roles.length === 1 ? recipe.roles[0] : undefined;
  if (only && !recipe.design.specialization.some((item) => item.role === only.role)) {
    recipe.design.specialization.push({
      proposed_by: "operator",
      accepted: true,
      role: only.role,
      reason: "other",
      detail: "Captured from a live guild that already runs as this single role.",
    });
  }
}

/** A guild of several roles hands off from its first role to its second, within its group message limit. */
function designHandoff(recipe: RecipeDocument): void {
  const [from, to] = recipe.roles;
  if (from && to && !recipe.design.handoffs.length) {
    recipe.design.handoffs.push({
      proposed_by: "operator",
      accepted: true,
      from: from.role,
      to: to.role,
      kind: "tagged",
      budget: recipe.guild.group_agent_message_limit,
    });
  }
}

/** Each routine a role runs, as an accepted design routine. */
function designRoutines(recipe: RecipeDocument, role: RecipeRole): void {
  for (const schedule of role.schedules) {
    if (!recipe.design.routines.some((item) => item.key === schedule.key)) {
      recipe.design.routines.push({
        proposed_by: "operator",
        accepted: true,
        key: schedule.key,
        role: role.role,
        cadence: schedule.cron ?? (schedule.window ? describeWindow(schedule.window) : ""),
        dedupe_key: "key",
      });
    }
  }
}

/** A role that browses, as an accepted design browser login. */
function designBrowser(recipe: RecipeDocument, role: RecipeRole): void {
  const browses = role.browser.required || Boolean(role.config.browser);
  if (browses && !recipe.design.browser.some((item) => item.role === role.role)) {
    recipe.design.browser.push({
      proposed_by: "operator",
      accepted: true,
      role: role.role,
      site: "",
      viable: true,
      login_failure_policy: "pause the routine and ask the operator to log in again",
    });
  }
}

/** The design a live guild already runs by, recorded as accepted decisions. */
function captureDesign(recipe: RecipeDocument): void {
  designSpecialization(recipe);
  designHandoff(recipe);
  for (const role of recipe.roles) {
    designRoutines(recipe, role);
    designBrowser(recipe, role);
  }
}

/**
 * A portable recipe of a live guild: its roles with their tasks, scripts, routines and access, the
 * tables and notes it reaches as `actor` reads them, its connections, secrets and repositories, and
 * the design it runs by. `includeNotes` names further notes by display path or file name.
 */
export async function captureGuild(
  deps: CaptureDeps,
  actor: ArtifactActor,
  guild: CapturedGuildRow,
  includeNotes: string[],
): Promise<RecipeDocument> {
  const agents = await deps.db.listAgents(guild.id);
  if (!agents.length) {
    throw new RecipeError("guild has no agents to capture");
  }
  const capture: Capture = {
    deps,
    recipe: guildRecipe(guild),
    orgId: guild.org_id,
    guildId: guild.id,
    actor,
    agents,
    captured: { guildId: guild.id, members: new Map(agents.map((agent) => [agent.id, agent.name])) },
  };
  await captureCollections(capture);
  for (const agent of agents) {
    await captureAgent(capture, agent);
  }
  await captureRepositories(capture);
  const hrefToNoteId = await captureNotes(capture, includeNotes);
  rewriteRefs(capture.recipe, { nameToRole: new Map(agents.map((agent) => [agent.name, agent.name])), hrefToNoteId });
  captureDesign(capture.recipe);
  return parseRecipe(capture.recipe);
}
