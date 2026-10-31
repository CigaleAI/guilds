import type { CapabilityServer } from "../../../api/types/builder";
import {
  asArray,
  asObject,
  enabledKeys,
  reviewLabel,
  type ConnectionDraft,
  type RecipeDraft,
  type SecretDraft,
} from "./recipeDraft";
import type { RecipePlan } from "./planModel";
import { toolKey, type PendingAccess } from "./pendingAccess";
import { systemCards, type SystemCard } from "./designSystems";

/** A catalog tool as the plan reads it; the first of its names that is set is its name. */
export type CatalogToolEntry = {
  namespaced_name?: string | null | undefined;
  remote_name?: string | null | undefined;
  name?: string | null | undefined;
};

/** A catalog connector as the plan reads it, matched to a recipe connector by `slug` or `server`. */
export type CatalogEntry = Omit<Partial<CapabilityServer>, "tools"> & {
  server?: string | null | undefined;
  tools?: readonly CatalogToolEntry[] | null | undefined;
};

/** True when a role uses a connector: every role does when the connector names none. */
export function roleUsesConnection(connection: ConnectionDraft, roleId: string): boolean {
  const roles = asObject(connection.roles);
  const keys = Object.keys(roles);
  if (!keys.length) return true;
  const entry = roles[roleId];
  if (!entry) return false;
  return entry.enabled !== false;
}

/** The connector tools the recipe switches on for a role. */
export function connectionTools(connection: ConnectionDraft, roleId: string): string[] {
  return enabledKeys(asObject(asObject(connection.roles)[roleId]).tools);
}

function catalogEntry(
  catalog: readonly CatalogEntry[] | null | undefined,
  server: string | null | undefined,
): CatalogEntry | null {
  return asArray(catalog).find((item) => item?.slug === server || item?.server === server) || null;
}

/** The tool names the catalog lists for a connector. */
export function catalogToolNames(
  catalog: readonly CatalogEntry[] | null | undefined,
  server: string | null | undefined,
): string[] {
  return asArray(catalogEntry(catalog, server)?.tools)
    .map((item) => String(item?.namespaced_name || item?.remote_name || item?.name || "").trim())
    .filter(Boolean);
}

/**
 * Every tool a role can have on a connector, sorted by name: the catalog's tools and those the
 * recipe mentions, each on unless the recipe or a pending switch turns it off.
 */
export function toolsForConnectionRole(
  connection: ConnectionDraft,
  roleId: string,
  catalog: readonly CatalogEntry[] | null | undefined,
  pending: PendingAccess | null = null,
): Array<{ name: string; enabled: boolean }> {
  const overlay = asObject(asObject(asObject(connection.roles)[roleId]).tools);
  const names = new Set([...catalogToolNames(catalog, connection.server), ...Object.keys(overlay)]);
  return [...names].sort().map((name) => {
    const key = toolKey(String(connection.server), roleId, name);
    const pendingEnabled = pending?.tools.get(key);
    return {
      name,
      enabled: pendingEnabled === undefined ? overlay[name] !== false : pendingEnabled,
    };
  });
}

function mergeConnection(base: ConnectionDraft, overlay: ConnectionDraft): ConnectionDraft {
  return {
    ...base,
    ...overlay,
    roles:
      overlay.roles && Object.keys(asObject(overlay.roles)).length ? overlay.roles : base.roles,
    setup: overlay.setup || overlay.hint || base.setup || base.hint || "",
    hint: overlay.hint || base.hint || "",
    author: overlay.author || base.author || null,
  };
}

export function connectionsFromRecipe(
  doc: RecipeDraft,
  overlayConnections: readonly ConnectionDraft[],
): ConnectionDraft[] {
  const byServer = new Map<string, ConnectionDraft>();
  for (const item of asArray(doc.connections)) {
    if (item?.server) byServer.set(item.server, item);
  }
  for (const item of overlayConnections) {
    if (!item?.server) continue;
    const current = byServer.get(item.server) || {};
    byServer.set(item.server, mergeConnection(current, item));
  }
  return [...byServer.values()];
}

/** The per-role tool lists of a connector, and the line shown when no role has any. */
export type ConnectionToolGroups = {
  groups: Array<{ role: string; title: string; tools: Array<{ name: string; enabled: boolean }> }>;
  empty: string | null;
};

/** A connector's tools grouped by the roles that use it; the group title is the agent's name when several roles share it. */
export function connectionToolGroups(
  connection: ConnectionDraft,
  plan: Pick<RecipePlan, "agents">,
  catalog: readonly CatalogEntry[] | null | undefined,
  pending: PendingAccess | null = null,
): ConnectionToolGroups {
  const roles = plan.agents.filter((agent) => roleUsesConnection(connection, agent.role));
  const groups: ConnectionToolGroups["groups"] = [];
  for (const agent of roles) {
    const tools = toolsForConnectionRole(connection, agent.role, catalog, pending);
    if (!tools.length) continue;
    groups.push({
      role: agent.role,
      title: roles.length > 1 ? `${agent.name || agent.role}` : "Tools",
      tools,
    });
  }
  let empty: string | null = null;
  if (!groups.length) {
    empty = catalogToolNames(catalog, connection.server).length
      ? "No tools listed for assigned roles."
      : "Catalog tools will appear here once this connector is published.";
  }
  return { groups, empty };
}

/** A connector's card. */
export type ConnectionCard = {
  server: string;
  reused: boolean;
  chip: { label: "reuse login" | "org login" | "connect at apply"; tone: "ok" | "action" };
  snippet: string;
  description: string;
  meta: string;
  resources: string[];
  reviewer: string | null;
  tools: ConnectionToolGroups;
};

/** True when apply reuses a live login for a connector: its plan says reuse and names the login. */
export function reusesLogin(connection: ConnectionDraft): boolean {
  return Boolean(connection.action === "reuse" && connection.connection_id);
}

/** A connector card's chip: the live login apply reuses, an organisation login, or one to connect at apply. */
function connectionChip(connection: ConnectionDraft): ConnectionCard["chip"] {
  if (reusesLogin(connection)) return { label: "reuse login", tone: "ok" };
  if (connection.recommended_scope === "org") return { label: "org login", tone: "action" };
  return { label: "connect at apply", tone: "action" };
}

/**
 * A connector's card: whether apply reuses a live login, its setup or the roles using it (with
 * their tools), its auth and scope line, its resources, and its tools per role.
 */
export function connectionCard(
  connection: ConnectionDraft,
  plan: Pick<RecipePlan, "agents">,
  catalog: readonly CatalogEntry[] | null | undefined,
  pending: PendingAccess | null = null,
): ConnectionCard {
  const roleBits = plan.agents
    .filter((agent) => roleUsesConnection(connection, agent.role))
    .map((agent) => {
      const tools = connectionTools(connection, agent.role);
      const label = agent.name || agent.role;
      return tools.length ? `${label} (${tools.join(", ")})` : label;
    });
  const description = connection.setup || connection.hint || "";
  return {
    server: connection.server ?? "",
    reused: reusesLogin(connection),
    chip: connectionChip(connection),
    snippet: description || (roleBits.length ? `Used by: ${roleBits.join(", ")}` : ""),
    description,
    meta: [
      connection.auth || "oauth",
      connection.recommended_scope || "guild",
      roleBits.join(", ") || "all roles",
    ].join(" · "),
    resources: asArray(connection.resources).map((resource) => {
      const title = resource.title || resource.id || "Untitled";
      const kind = resource.kind || "table";
      return resource.use ? `${kind}: ${title} — ${resource.use}` : `${kind}: ${title}`;
    }),
    reviewer: reviewLabel(connection.author),
    tools: connectionToolGroups(connection, plan, catalog, pending),
  };
}

/** A secret's card: the name it is stored under and its description or scope. */
export function secretCard(secret: SecretDraft): { name: string; snippet: string } {
  return {
    name: secret.dest_name || secret.name || "",
    snippet: secret.description || secret.recommended_scope || "",
  };
}

/** The connectors section: its count (connectors and secrets), its listed systems, and whether it has nothing to list. */
export function accessSection(plan: RecipePlan): {
  count: number;
  systems: SystemCard[];
  empty: boolean;
} {
  const systems = systemCards(plan);
  return {
    count: plan.connections.length + plan.secrets.length,
    systems,
    empty: !plan.connections.length && !plan.secrets.length && !systems.length,
  };
}
