import type { ArtifactStore } from "../artifacts/index.js";
import { listMcpServers } from "../connectors/servers.js";
import { countOrgAgents, countOrgBrowserAgents, countOrgCodingAgents } from "../db/orgs.js";
import type { Queryable } from "../db/pg.js";
import { coreModelCredentials, modelProviderStore } from "../llm/credentials.js";
import { modelsDatabase, ModelsService } from "../llm/models.js";
import type { NotesStore } from "../notes/store.js";
import { OPEN_POLICY, remaining, type OrgPolicy } from "../policy/index.js";
import { registryClient, type RegistryClient } from "../registry/client.js";
import { pickEntry, type RegistryIndex } from "../registry/index.js";
import type { Schedules } from "../schedules/service.js";
import type { Scripts } from "../scripts/catalog.js";
import type { ValidationContext } from "./findings.js";
import type { NameDecision } from "../db/schema/index.js";
import type { RecipeDocument } from "./schema.js";

// What applying a recipe needs, and what the operator chooses on its preview. The apply itself
// is planned in plan.ts, created in skeleton.ts, walked through in checklist.ts, and closed in
// lifecycle.ts.

export type ApplyDeps = {
  db: Queryable;
  artifacts: ArtifactStore;
  notes: NotesStore;
  scripts: Scripts;
  schedules: Schedules;
  policy?: OrgPolicy;
  /** The registry a missing connector may install from: the box's `REGISTRY_URL` when absent, none when null. */
  registry?: RegistryClient | null;
  /** The organisation's connected providers and default model; core's own rows when absent. */
  models?: ModelsService;
};

/** The services an apply runs on: `ApplyDeps` with the policy, registry and models settled. */
export type RecipeApply = {
  db: Queryable;
  artifacts: ArtifactStore;
  notes: NotesStore;
  scripts: Scripts;
  schedules: Schedules;
  policy: OrgPolicy;
  registry: RegistryClient | null;
  models: ModelsService;
};

export function recipeApply(deps: ApplyDeps): RecipeApply {
  return {
    db: deps.db,
    artifacts: deps.artifacts,
    notes: deps.notes,
    scripts: deps.scripts,
    schedules: deps.schedules,
    policy: deps.policy ?? OPEN_POLICY,
    registry: deps.registry === undefined ? registryClient() : deps.registry,
    models:
      deps.models ??
      new ModelsService({ db: modelsDatabase(deps.db), credentials: coreModelCredentials(modelProviderStore(deps.db)) }),
  };
}

export type ConnectionDecision = {
  server: string;
  action: "reuse" | "create";
  scope: "guild" | "agent";
  role?: string;
  connection_id?: string;
};

export type SecretDecision = { name: string; action: "reuse" | "rename" | "skip"; dest_name?: string };

/** The model the operator picked for a role on the apply preview. */
export type ModelDecision = { role: string; model: string };

/** The harness the operator picked for a coding role on the apply preview. */
export type HarnessDecision = { role: string; harness: string };

export type ApplyChoices = {
  guild_name?: string;
  guild_id?: string;
  names?: NameDecision[];
  models?: ModelDecision[];
  /** The harness of each coding role. */
  harnesses?: HarnessDecision[];
  connections?: ConnectionDecision[];
  secrets?: SecretDecision[];
  activate_keys?: string[];
  /** The machine every role goes on; the organisation's only one when absent. */
  machine_id?: string;
};

type RegistryOffer = { version: string; verified: boolean };

/**
 * What the registry offers among the connectors `recipe` names that the box lacks and the
 * recipe does not carry; empty while offline or when the index cannot be read.
 */
async function registryOffers(
  apply: RecipeApply,
  recipe: RecipeDocument,
  servers: readonly string[],
): Promise<Map<string, RegistryOffer>> {
  const missing = new Set(
    recipe.connections.filter((item) => !servers.includes(item.server) && !item.manifest).map((item) => item.server),
  );
  if (!missing.size || apply.registry === null) {
    return new Map();
  }
  let index: RegistryIndex;
  try {
    index = await apply.registry.index();
  } catch {
    return new Map();
  }
  const offers = new Map<string, RegistryOffer>();
  for (const slug of missing) {
    const entry = pickEntry(index.connectors.filter((item) => item.slug === slug));
    if (entry) {
      offers.set(slug, { version: entry.version, verified: entry.verified });
    }
  }
  return offers;
}

/** The context a recipe validates against; given the recipe, what the registry offers for the connectors the box lacks. */
export async function validationContext(
  apply: RecipeApply,
  orgId: string,
  recipe?: RecipeDocument,
): Promise<ValidationContext> {
  const { limits } = await apply.policy.standing(orgId);
  const agents = await countOrgAgents(apply.db, orgId);
  const browsers = await countOrgBrowserAgents(apply.db, orgId);
  const coders = await countOrgCodingAgents(apply.db, orgId);
  const servers = (await listMcpServers(apply.db, orgId)).filter((row) => row.enabled !== false).map((row) => row.slug);
  return {
    publishedServers: new Set(servers),
    ...(recipe ? { registryConnectors: await registryOffers(apply, recipe, servers) } : {}),
    remainingAgents: remaining(limits.maxAgents, agents),
    remainingBrowserAgents: remaining(limits.maxBrowserAgents, browsers),
    remainingCodingAgents: remaining(limits.maxCodingAgents, coders),
    groupLimit: 20,
    connectedProviders: await apply.models.connectedProviders(orgId),
  };
}
