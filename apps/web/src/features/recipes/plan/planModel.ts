import {
  asArray,
  asObject,
  recipeBody,
  type BrowserSiteDraft,
  type CollectionDraft,
  type ConnectionDraft,
  type CreatesDraft,
  type ExternalDraft,
  type HandoffDraft,
  type NoteDraft,
  type RecipeSource,
  type RepositoryDraft,
  type RoleDraft,
  type SecretDraft,
  type SystemDraft,
} from "./recipeDraft";
import { planAgent, rolesFromCreatedAgents, type PlanAgent, type PlanScript } from "./planAgents";
import { scheduledRoutine, type PlanRoutine } from "./planRoutines";
import { connectionsFromRecipe } from "./planConnectors";
import { collectionsFromRecipe, type PlanCollection } from "./planCollections";
import { notesFromRecipe } from "./planNotes";
import type { PlanAction } from "./planActions";

/**
 * What the apply preview adds on top of the recipe: its inventory, and planned connectors and
 * secrets used when the inventory has none.
 */
export type PlanOverlay = {
  creates?: CreatesDraft | null | undefined;
  connections?: readonly ConnectionDraft[] | null | undefined;
  secrets?: readonly SecretDraft[] | null | undefined;
};

/** The guild the plan creates. */
export type PlanGuild = { name: string; about: string; objective: string; groupLimit: number };

/** How many of each thing the plan holds. */
export type PlanCounts = {
  agents: number;
  collections: number;
  notes: number;
  scripts: number;
  routines: number;
  connections: number;
  secrets: number;
};

/** Everything a recipe creates and needs, ready to show. */
export type RecipePlan = {
  guild: PlanGuild;
  agents: PlanAgent[];
  collections: PlanCollection[];
  notes: readonly NoteDraft[];
  scripts: PlanScript[];
  routines: PlanRoutine[];
  connections: ConnectionDraft[];
  secrets: readonly SecretDraft[];
  external: readonly ExternalDraft[];
  repositories: readonly RepositoryDraft[];
  systems: readonly SystemDraft[];
  handoffs: readonly HandoffDraft[];
  browserSites: readonly BrowserSiteDraft[];
  actions: PlanAction[];
  counts: PlanCounts;
};

/** The group messages per agent a guild allows when its recipe names no limit, as the orchestrator applies it. */
const DEFAULT_GROUP_LIMIT = 200;

/**
 * Everything a recipe creates and needs, ready to show: the guild, its agents with their routines,
 * collections, notes, scripts, connectors, secrets, external setup, design systems, handoffs, and
 * the operator steps apply needs. The apply preview's inventory, when given, overrides the recipe's
 * routines, connectors, secrets, collections, and notes, and supplies agents when the recipe has
 * no roles.
 */
export function planFromRecipe(recipe: RecipeSource, overlay: PlanOverlay = {}): RecipePlan {
  const doc = recipeBody(recipe);
  const guild = asObject(doc.guild);
  const meta = asObject(doc.meta);
  const design = asObject(doc.design);
  const creates = asObject(overlay.creates);
  const overlayRoutines = asArray(creates.routines);
  const overlayConnections = asArray<ConnectionDraft>(
    creates.connections?.length ? creates.connections : overlay.connections,
  );
  const overlaySecrets = asArray<SecretDraft>(
    creates.secrets?.length ? creates.secrets : overlay.secrets,
  );
  let roles: readonly RoleDraft[] = asArray(doc.roles);
  const createdAgents = asArray(creates.agents);
  if (!roles.length && createdAgents.length) {
    roles = rolesFromCreatedAgents(createdAgents, overlayRoutines);
  }
  const agents = roles.map((role) => planAgent(role, doc, overlayRoutines));
  const routines = overlayRoutines.length
    ? overlayRoutines.map((item) => scheduledRoutine(item, item.role ?? "", "apply"))
    : agents.flatMap((agent) => agent.routines);
  const connections = connectionsFromRecipe(doc, overlayConnections);
  const collections = collectionsFromRecipe(
    asArray<CollectionDraft>(doc.collections),
    asArray(creates.collections),
  );
  const notes = notesFromRecipe(asArray(doc.notes), asArray<NoteDraft>(creates.notes));
  const scripts = agents.flatMap((agent) =>
    agent.scripts.map((item) => ({
      role: agent.role,
      name: item.name ?? "",
      description: item.description || "",
      author: item.author || null,
      source: item.source || "",
    })),
  );
  const secrets = overlaySecrets.length ? overlaySecrets : asArray<SecretDraft>(doc.secrets);
  const external = asArray(doc.external);
  const repositories = asArray(doc.repositories).length
    ? asArray(doc.repositories)
    : asArray<RepositoryDraft>(creates.repositories);
  const systems = asArray(design.systems);
  const handoffs = asArray(design.handoffs);
  const browserSites = asArray(design.browser);
  const actions: PlanAction[] = [];
  for (const connection of connections) {
    const reused = Boolean(connection.action === "reuse" && connection.connection_id);
    actions.push({
      kind: reused ? "reuse" : "connect",
      title: reused ? `Reuse ${connection.server}` : `Connect ${connection.server}`,
      detail:
        connection.setup ||
        connection.hint ||
        `${connection.auth || "oauth"} · ${connection.recommended_scope || "guild"}`,
      path: `connections.${connection.server}.setup`,
      author: connection.author || null,
      required: !reused,
      server: connection.server ?? "",
    });
  }
  for (const secret of secrets) {
    actions.push({
      kind: "secret",
      title: `Provide ${secret.dest_name || secret.name}`,
      detail: secret.description || secret.recommended_scope || "",
      path: `secrets.${secret.name}`,
      author: null,
      required: secret.action !== "reuse" && secret.action !== "skip",
    });
  }
  if (repositories.length && !connections.some((connection) => connection.server === "github")) {
    actions.push({
      kind: "connect",
      title: "Connect GitHub",
      detail:
        "Install the GitHub App on the account that owns the repositories, or reuse an existing install. Pick this login's repositories on the GitHub card in Tools.",
      path: "repositories",
      author: null,
      required: false,
      server: "github",
    });
  }
  for (const repository of repositories) {
    actions.push({
      kind: "repository",
      title: `Add the ${repository.name ?? ""} repository`,
      detail: repository.purpose || "Add it in the guild's Settings under Repositories.",
      path: `repositories.${repository.name ?? ""}`,
      author: null,
      required: true,
    });
  }
  for (const agent of agents) {
    if (!agent.browser) continue;
    const site = browserSites.find((item) => item.role === agent.role)?.site;
    actions.push({
      kind: "browser",
      title: `Take control and log ${agent.name} into ${site || "the web page"}`,
      detail:
        agent.browserInstructions ||
        "No native connector. After apply, open this agent and log in from the Browser tab.",
      path: `roles.${agent.role}.browser`,
      author: agent.browserAuthor,
      required: true,
      role: agent.role,
    });
  }
  for (const [index, card] of external.entries()) {
    actions.push({
      kind: "external",
      title: card.title || card.kind || "External setup",
      detail: card.setup || "",
      path: `external[${index}]`,
      author: card.author || null,
      required: true,
    });
  }
  return {
    guild: {
      name: meta.name || guild.name_suggestion || creates.guild?.name || "Untitled guild",
      about: guild.about || creates.guild?.about || meta.description || "",
      objective: guild.objective || creates.guild?.objective || "",
      groupLimit: guild.group_agent_message_limit ?? DEFAULT_GROUP_LIMIT,
    },
    agents,
    collections,
    notes,
    scripts,
    routines,
    connections,
    secrets,
    external,
    repositories,
    systems,
    handoffs,
    browserSites,
    actions,
    counts: {
      agents: agents.length,
      collections: collections.length,
      notes: notes.length,
      scripts: scripts.length,
      routines: routines.length,
      connections: connections.length,
      secrets: secrets.length,
    },
  };
}
