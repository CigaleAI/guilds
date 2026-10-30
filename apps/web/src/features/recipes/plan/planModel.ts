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
  type RecipeDraft,
  type RecipeSource,
  type RepositoryDraft,
  type SecretDraft,
  type SystemDraft,
} from "./recipeDraft";
import { planAgent, planRoles, type PlanAgent, type PlanScript } from "./planAgents";
import { scheduledRoutine, type PlanRoutine } from "./planRoutines";
import { connectionsFromRecipe } from "./planConnectors";
import { collectionsFromRecipe, type PlanCollection } from "./planCollections";
import { notesFromRecipe } from "./planNotes";
import {
  browserActions,
  connectionAction,
  externalActions,
  repositoryActions,
  secretAction,
  type PlanAction,
} from "./planActions";

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

/** The guild the plan creates: the recipe's name and texts, falling back on the apply plan's guild. */
function planGuild(doc: RecipeDraft, creates: CreatesDraft): PlanGuild {
  const guild = asObject(doc.guild);
  const meta = asObject(doc.meta);
  const created = asObject(creates.guild);
  return {
    name: meta.name || guild.name_suggestion || created.name || "Untitled guild",
    about: guild.about || created.about || meta.description || "",
    objective: guild.objective || created.objective || "",
    groupLimit: guild.group_agent_message_limit ?? DEFAULT_GROUP_LIMIT,
  };
}

/** The apply plan's connectors: its inventory's when it lists any, the preview's planned ones otherwise. */
function overlayConnections(overlay: PlanOverlay): readonly ConnectionDraft[] {
  const creates = asObject(overlay.creates);
  return asArray(creates.connections?.length ? creates.connections : overlay.connections);
}

/** The apply plan's secrets: its inventory's when it lists any, the preview's planned ones otherwise. */
function overlaySecrets(overlay: PlanOverlay): readonly SecretDraft[] {
  const creates = asObject(overlay.creates);
  return asArray(creates.secrets?.length ? creates.secrets : overlay.secrets);
}

/**
 * Everything a recipe creates and needs, ready to show: the guild, its agents with their routines,
 * collections, notes, scripts, connectors, secrets, external setup, design systems, handoffs, and
 * the operator steps apply needs. The apply preview's inventory, when given, overrides the recipe's
 * routines, connectors, secrets, collections, and notes, and supplies agents when the recipe has
 * no roles.
 */
export function planFromRecipe(recipe: RecipeSource, overlay: PlanOverlay = {}): RecipePlan {
  const doc = recipeBody(recipe);
  const design = asObject(doc.design);
  const creates = asObject(overlay.creates);
  const overlayRoutines = asArray(creates.routines);
  const roles = planRoles(doc, asArray(creates.agents), overlayRoutines);
  const agents = roles.map((role) => planAgent(role, doc, overlayRoutines));
  const routines = overlayRoutines.length
    ? overlayRoutines.map((item) => scheduledRoutine(item, item.role ?? "", "apply"))
    : agents.flatMap((agent) => agent.routines);
  const connections = connectionsFromRecipe(doc, overlayConnections(overlay));
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
  const planned = overlaySecrets(overlay);
  const secrets = planned.length ? planned : asArray<SecretDraft>(doc.secrets);
  const external = asArray(doc.external);
  const repositories = asArray(doc.repositories).length
    ? asArray(doc.repositories)
    : asArray<RepositoryDraft>(creates.repositories);
  const browserSites = asArray(design.browser);
  return {
    guild: planGuild(doc, creates),
    agents,
    collections,
    notes,
    scripts,
    routines,
    connections,
    secrets,
    external,
    repositories,
    systems: asArray(design.systems),
    handoffs: asArray(design.handoffs),
    browserSites,
    actions: [
      ...connections.map(connectionAction),
      ...secrets.map(secretAction),
      ...repositoryActions(repositories, connections),
      ...browserActions(agents, browserSites),
      ...externalActions(external),
    ],
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
