import { Type } from "@sinclair/typebox";
import { getMcpServerBySlug } from "../connectors/servers.js";
import { HARNESSES } from "../db/schema/index.js";
import { decode } from "../lib/decode.js";
import { newId } from "../lib/ids.js";
import { operatorActor } from "../artifacts/actors.js";
import { collectTaskEmbeds } from "../artifacts/index.js";
import type { AccessEntry, ArtifactActor, ArtifactStore } from "../artifacts/index.js";
import { loadAccessView } from "../access/view.js";
import type { Scripts } from "../scripts/catalog.js";
import type { Schedules } from "../schedules/service.js";
import { rowTiming } from "../schedules/timing.js";
import { describeWindow } from "../schedules/window.js";
import {
  CONFIG_KEYS,
  addMissingBrowser,
  addMissingBrowserLanguage,
  addMissingScriptingAndMemory,
  addMissingRunLimits,
  addMissingTemperatureAndStepLimits,
  addMissingThinkingLevel,
  secretAliasesOf,
} from "../agents/validation.js";
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
import { mcpDatabase } from "../mcp/index.js";
import { getAgentTask, listAgents, type GuildAgentRow } from "../db/agents.js";
import { listSchedules } from "../db/schedules.js";
import { listSecrets, type SecretRow } from "../db/secrets.js";
import { listGuildRepositories, type GuildRow } from "../db/guilds.js";
import { bindQuery, type Queryable } from "../db/pg.js";
import type { UserRow } from "../db/users.js";
import { getByDisplayPath, listEmbeddableNotes } from "../artifacts/notes.js";
import { listAccess } from "../artifacts/access-lists.js";
import { listCollections } from "../artifacts/collections.js";

/** The db/ functions a guild is captured into a recipe through, on `db`. */
export function captureDatabase(db: Queryable) {
  return {
    ...mcpDatabase(db),
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
    getByDisplayPath: bindQuery(store, getByDisplayPath),
    listAccess: bindQuery(store, listAccess),
    listCollections: bindQuery(store, listCollections),
    listEmbeddableNotes: bindQuery(store, listEmbeddableNotes),
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

/** The harness keys a role leaves out while unset. */
const HARNESS_KEYS = new Set(["harness", "harness_model", "harness_effort"]);

/** The variables the harnesses read their subscription tokens from. */
const HARNESS_TOKEN_VARIABLES = new Set(
  HARNESSES.flatMap((harness) => HARNESS_INFO[harness].secret ?? []),
);

/**
 * The secrets a coding agent's harnesses read their subscription tokens from. They are the
 * operator's own subscription, so a recipe leaves them out: the applying operator sets one up
 * for the harness they pick.
 */
function harnessTokenSecrets(config: Record<string, unknown>): Set<string> {
  if (config.coding !== true) return new Set();
  const aliases = secretAliasesOf(config);
  return new Set(HARNESSES.flatMap((harness) => harnessSecretSource(harness, aliases) ?? []));
}

/** The role's secret aliases a recipe carries: a coding role's harness token aliases stay behind. */
function portableSecretAliases(config: Record<string, unknown>): Record<string, string> {
  const aliases = secretAliasesOf(config);
  if (config.coding !== true) return aliases;
  return Object.fromEntries(Object.entries(aliases).filter(([variable]) => !HARNESS_TOKEN_VARIABLES.has(variable)));
}

function clippedHint(value: string | null | undefined): string {
  return (value ?? "").slice(0, RECIPE_HINT_MAX);
}

/** The access list of the live note at `displayPath`; empty when there is none. */
async function noteAccessEntries(artifacts: CaptureArtifacts, actor: ArtifactActor, displayPath: string): Promise<AccessEntry[]> {
  const found = await artifacts.getByDisplayPath(actor, displayPath);
  return found.row ? artifacts.listAccess(actor, { kind: "note", id: found.row.id }) : [];
}

export function portableRoleConfig(
  config: Record<string, unknown>,
  browserRequired: boolean,
): Record<string, unknown> {
  const filled = addMissingScriptingAndMemory(
    addMissingThinkingLevel(
      addMissingBrowserLanguage(
        addMissingRunLimits(
          addMissingTemperatureAndStepLimits(
            addMissingBrowser({
              ...config,
              browser: browserRequired || Boolean(config.browser),
            }),
          ),
        ),
      ),
    ),
  );
  const out: Record<string, unknown> = {};
  for (const key of CONFIG_KEYS) {
    // A recipe carries the flags alone: at apply the box follows them, and a custom size stays behind.
    if (key === "box" || key === "cpu" || key === "memory_mib") {
      continue;
    }
    // A role without a harness, or on its harness's default model or effort, leaves the key out; apply settles it.
    if (HARNESS_KEYS.has(key) && filled[key] == null) {
      continue;
    }
    // A role left without secret aliases leaves the key out.
    if (key === "secret_aliases") {
      const aliases = portableSecretAliases(filled);
      if (Object.keys(aliases).length) {
        out.secret_aliases = aliases;
      }
      continue;
    }
    if (key in filled) {
      out[key] = filled[key];
    }
  }
  return out;
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

/** A note as the store lists it for embedding, with the fields a seed note is captured from. */
const NoteView = Type.Object({
  display_path: Type.String(),
  key: Type.String(),
  kind: Type.String(),
  level: Type.Union([Type.Literal("org"), Type.Literal("guild"), Type.Literal("agent")]),
  content: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  owner_id: Type.Optional(Type.Union([Type.String(), Type.Null()])),
});

type NoteView = (typeof NoteView)["static"];

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
  for (const collection of await deps.artifacts.listCollections(actor)) {
    const table = { name: collection.name, purpose: collection.purpose, columns: collection.columns };
    if (collection.scope === "guild") {
      if (collection.guild?.id === guildId) {
        recipe.collections.push({ ...table, scope: "guild", guild: "write", writers: [] });
      }
      continue;
    }
    const entries = await deps.artifacts.listAccess(actor, { kind: "collection", id: collection.id });
    const reach = capturedTableAccess(entries, capture.captured);
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
  const config: Record<string, unknown> = agent.config;
  const taskBody = (await capture.deps.db.getAgentTask(capture.orgId, agent.id))?.content_text ?? "";
  const scripts = await captureScripts(capture, agent.id);
  const browserRequired = Boolean(config.browser);
  const portable = portableRoleConfig(config, browserRequired);
  if (scripts.length > Number(portable.max_scripts ?? 0)) {
    portable.max_scripts = scripts.length;
  }
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
function seedNote(capture: Capture, note: NoteView): RecipeNote {
  const seed: RecipeNote = {
    id: newId("nte").slice(0, 16),
    level: note.level,
    key: note.key,
    body: note.content ?? "",
    kind: "seed",
    author: operatorAuthor(),
    writers: [],
  };
  const owner = note.level === "agent" ? capture.agents.find((agent) => agent.id === (note.owner_id ?? "")) : undefined;
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
  for (const listed of await deps.artifacts.listEmbeddableNotes(actor)) {
    const note = decode(NoteView, listed, uncapturable);
    const wanted = include.has(note.display_path) || include.has(note.key);
    if (!wanted || note.key === "memory.md" || note.kind !== "note") {
      continue;
    }
    const seed = seedNote(capture, note);
    const entries = await noteAccessEntries(deps.artifacts, actor, note.display_path);
    Object.assign(seed, capturedNoteAccess(entries, seed, capture.captured));
    hrefToNoteId.set(note.display_path, recipeNotePath(seed));
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
 * tables and notes it reaches, its connections, secrets and repositories, and the design it runs by.
 */
export async function captureGuild(
  deps: CaptureDeps,
  source: { guild: CapturedGuildRow; user: UserRow; includeNotes?: string[] },
): Promise<RecipeDocument> {
  const { guild, user } = source;
  const agents = await deps.db.listAgents(guild.id);
  if (!agents.length) {
    throw new RecipeError("guild has no agents to capture");
  }
  const capture: Capture = {
    deps,
    recipe: guildRecipe(guild),
    orgId: guild.org_id,
    guildId: guild.id,
    actor: operatorActor({ orgId: guild.org_id, actorId: user.id, actorName: user.name, guildId: guild.id }),
    agents,
    captured: { guildId: guild.id, members: new Map(agents.map((agent) => [agent.id, agent.name])) },
  };
  await captureCollections(capture);
  for (const agent of agents) {
    await captureAgent(capture, agent);
  }
  await captureRepositories(capture);
  const hrefToNoteId = await captureNotes(capture, source.includeNotes ?? []);
  rewriteRefs(capture.recipe, { nameToRole: new Map(agents.map((agent) => [agent.name, agent.name])), hrefToNoteId });
  captureDesign(capture.recipe);
  return parseRecipe(capture.recipe);
}
