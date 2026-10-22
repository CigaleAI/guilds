import { createHash } from "node:crypto";
import {
  BindingError,
  resolvedMcp,
  resolvedTools,
  validateCatalog,
  type Resolved,
} from "../access/index.js";
import { resolveMcpTool } from "../access/runtime.js";
import { newId } from "../lib/ids.js";
import { isReadOnlyRemote, listedFromRows } from "../mcp/index.js";
import type { EditScope } from "./edits.js";
import { editActor } from "./actor.js";
import { StudioConflictError, StudioUnprocessableError } from "./errors.js";

// One agent's access as the coach proposes to narrow or widen it: the native
// tools, and the connections and connection tools it is offered. A change is an agent-level overlay; the guild's and the
// organisation's settings stay as they are. Like every Studio edit, a
// proposal writes nothing until the operator applies it.

export const STUDIO_ACCESS_TOOLS = ["studio_edit_access"] as const;
export type StudioAccessTool = (typeof STUDIO_ACCESS_TOOLS)[number];

export function isAccessTool(name: string): name is StudioAccessTool {
  return (STUDIO_ACCESS_TOOLS as readonly string[]).includes(name);
}

const SETTINGS = ["on", "off", "inherit"] as const;
type Setting = (typeof SETTINGS)[number];

type CatalogKind = "native_tool" | "mcp" | "mcp_tool";

type Change = { kind: CatalogKind; id: string; label: string; setting: Setting };

type ListedTool = { name: string; readOnly: boolean };

type AgentConnection = {
  id: string;
  serverId: string;
  label: string;
  status: string;
  tools: ListedTool[];
};

/** Everything the agent's access resolves from, loaded once. */
type Snapshot = {
  agentId: string;
  agentName: string;
  scope: { orgId: string; guildId: string; agentId: string };
  rows: Array<Record<string, unknown>>;
  servers: Array<Record<string, unknown>>;
  connections: Map<string, AgentConnection>;
};

/**
 * An access proposal checked against the live bindings: the access before and
 * after, rendered as text, what applying does, the hashes that bind it, and
 * the overlays it writes.
 */
export type AccessReview = {
  title: string;
  target: Record<string, unknown>;
  baseHash: string;
  proposedHash: string;
  live: string;
  proposed: string;
  effects: string[];
  changes: Change[];
  /** Whether applying turns on anything the agent cannot use today. */
  widens: boolean;
};

function hashOf(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
}

async function loadSnapshot(scope: EditScope, agentId: string): Promise<Snapshot> {
  const agent = await scope.repo.getAgent(agentId);
  if (!agent || String(agent.guild_id) !== scope.sourceGuildId || String(agent.org_id) !== scope.orgId) {
    throw new StudioUnprocessableError("agent is not in the source guild");
  }
  const resolveScope = { orgId: scope.orgId, guildId: scope.sourceGuildId, agentId };
  const rows = await scope.repo.listBindingsCovering(resolveScope);
  const servers = await scope.repo.listMcpServers(scope.orgId);
  const serverById = new Map(servers.map((server) => [String(server.id), server]));
  const connections = new Map<string, AgentConnection>();
  for (const connection of await scope.repo.listMcpConnections(resolveScope)) {
    const server = serverById.get(String(connection.mcp_server_id));
    if (!server) continue;
    const listed = listedFromRows(await scope.repo.listMcpTools(String(connection.id)));
    const name = String(server.display_name || server.slug);
    const account = String(connection.account_hint ?? "");
    connections.set(String(connection.id), {
      id: String(connection.id),
      serverId: String(server.id),
      label: `${name} (${connection.owner_scope} login${account ? `, ${account}` : ""})`,
      status: String(connection.status),
      tools: listed.map((tool) => ({
        name: tool.namespaced_name,
        readOnly: isReadOnlyRemote(String(server.slug), tool.remote_name, {
          readOnlyHint: tool.read_only_hint,
          verified: server.verified === true,
        }),
      })),
    });
  }
  return {
    agentId,
    agentName: String(agent.name),
    scope: resolveScope,
    rows,
    servers,
    connections,
  };
}

/** The connections the agent's bindings resolve, with the server each one serves. */
function agentConnections(snapshot: Snapshot, rows: Array<Record<string, unknown>>): Array<{ item: Resolved; connection: AgentConnection }> {
  const found: Array<{ item: Resolved; connection: AgentConnection }> = [];
  for (const [item] of resolvedMcp(rows, snapshot.servers, snapshot.scope)) {
    const connection = item.connection_id === null ? undefined : snapshot.connections.get(item.connection_id);
    if (connection) found.push({ item, connection });
  }
  return found;
}

function stateOf(item: Resolved): string {
  return `${item.enabled ? "on" : "off"}${item.source_scope === "agent" ? ", set on this agent" : ""}`;
}

/** The access as the operator reads it in a diff: one line per tool and connection. */
function render(snapshot: Snapshot, rows: Array<Record<string, unknown>>): string {
  const lines = [`${snapshot.agentName} · access`, "", "native tools"];
  for (const item of resolvedTools(rows, snapshot.scope)) {
    lines.push(`- ${item.catalog_id}: ${stateOf(item)}`);
  }
  lines.push("", "connections");
  const connections = agentConnections(snapshot, rows);
  if (!connections.length) lines.push("- none");
  for (const { item, connection } of connections) {
    const status = connection.status === "connected" ? "" : `, ${connection.status}`;
    lines.push(`- ${connection.label}: ${stateOf(item)}${status}`);
    for (const tool of connection.tools) {
      const resolved = resolveMcpTool(rows, tool.name, { serverEnabled: item.enabled, ...snapshot.scope });
      lines.push(`  - ${tool.name}: ${stateOf(resolved)}${tool.readOnly ? "" : ", changes data"}`);
    }
  }
  return lines.join("\n");
}

function agentRow(snapshot: Snapshot, rows: Array<Record<string, unknown>>, kind: CatalogKind, id: string) {
  return rows.find(
    (row) =>
      row.catalog_kind === kind &&
      row.catalog_id === id &&
      row.scope === "agent" &&
      String(row.scope_id) === snapshot.agentId,
  );
}

/** The bindings as they stand once each change is written. */
function rowsAfter(snapshot: Snapshot, changes: Change[]): Array<Record<string, unknown>> {
  let rows = [...snapshot.rows];
  for (const change of changes) {
    const existing = agentRow(snapshot, rows, change.kind, change.id);
    rows = rows.filter((row) => row !== existing);
    if (change.setting !== "inherit") {
      rows.push({
        catalog_kind: change.kind,
        catalog_id: change.id,
        scope: "agent",
        scope_id: snapshot.agentId,
        enabled: change.setting === "on",
        connection_id: existing?.connection_id ?? null,
      });
    }
  }
  return rows;
}

function settingOf(raw: unknown, field: string, name: string): Setting {
  if (!(SETTINGS as readonly unknown[]).includes(raw)) {
    throw new StudioUnprocessableError(`${field}.${name} must be on, off, or inherit`);
  }
  return raw as Setting;
}

function entries(args: Record<string, unknown>, field: string): Array<[string, Setting]> {
  const raw = args[field];
  if (raw === undefined || raw === null) return [];
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new StudioUnprocessableError(`${field} must be an object of name to on, off, or inherit`);
  }
  return Object.entries(raw as Record<string, unknown>).map(([name, value]) => [name.trim(), settingOf(value, field, name)]);
}

function nativeToolId(name: string): string {
  try {
    return validateCatalog("native_tool", name)[1];
  } catch (error) {
    if (error instanceof BindingError) throw new StudioUnprocessableError(error.message);
    throw error;
  }
}

/** The overlays a proposal asks for; a setting the agent already has is not a change. */
function parseChanges(snapshot: Snapshot, args: Record<string, unknown>): Change[] {
  const changes: Change[] = [];
  const seen = new Set<string>();
  const add = (change: Change) => {
    const key = `${change.kind}\0${change.id}`;
    if (seen.has(key)) {
      throw new StudioUnprocessableError(`${change.label} is listed twice`);
    }
    seen.add(key);
    const existing = agentRow(snapshot, snapshot.rows, change.kind, change.id);
    const unchanged =
      change.setting === "inherit" ? !existing : Boolean(existing) && Boolean(existing?.enabled) === (change.setting === "on");
    if (!unchanged) changes.push(change);
  };
  for (const [name, setting] of entries(args, "native_tools")) {
    const id = nativeToolId(name);
    add({ kind: "native_tool", id, label: id, setting });
  }
  const connections = agentConnections(snapshot, snapshot.rows).map((item) => item.connection);
  for (const [id, setting] of entries(args, "connections")) {
    const connection = connections.find((item) => item.id === id);
    if (!connection) {
      throw new StudioUnprocessableError(
        `connections.${id} is not a connection of ${snapshot.agentName}; use an id from studio_get_agent_access`,
      );
    }
    add({ kind: "mcp", id: connection.serverId, label: connection.label, setting });
  }
  for (const [name, setting] of entries(args, "connection_tools")) {
    if (!connections.some((connection) => connection.tools.some((tool) => tool.name === name))) {
      throw new StudioUnprocessableError(
        `connection_tools.${name} is not a tool of ${snapshot.agentName}'s connections; use a name from studio_get_agent_access`,
      );
    }
    add({ kind: "mcp_tool", id: name, label: name, setting });
  }
  return changes;
}

function accessEffects(snapshot: Snapshot, after: Array<Record<string, unknown>>, changes: Change[]): string[] {
  const name = snapshot.agentName;
  const effects = [`Takes effect from ${name}'s next run; a run already going keeps what it started with.`];
  const before = new Map(agentConnections(snapshot, snapshot.rows).map(({ item, connection }) => [connection.serverId, item.enabled]));
  const now = agentConnections(snapshot, after);
  for (const change of changes) {
    if (change.kind === "mcp") {
      const entry = now.find(({ connection }) => connection.serverId === change.id);
      if (entry && entry.item.enabled !== before.get(change.id)) {
        effects.push(
          entry.item.enabled
            ? `Offers ${name} every ${entry.connection.label} tool that is not turned off.`
            : `Withdraws every ${entry.connection.label} tool from ${name}.`,
        );
      }
    }
  }
  for (const { item, connection } of now) {
    for (const tool of connection.tools) {
      if (tool.readOnly) continue;
      const was = resolveMcpTool(snapshot.rows, tool.name, {
        serverEnabled: before.get(connection.serverId) ?? false,
        ...snapshot.scope,
      }).enabled;
      const is = resolveMcpTool(after, tool.name, { serverEnabled: item.enabled, ...snapshot.scope }).enabled;
      if (is && !was) {
        effects.push(`Lets ${name} call ${tool.name}, which can change data in ${connection.label}.`);
      }
    }
  }
  return effects;
}

/** Everything the agent can use under these bindings, one key per tool and connection. */
function enabledAccess(snapshot: Snapshot, rows: Array<Record<string, unknown>>): Set<string> {
  const on = (prefix: string, items: Resolved[]) =>
    items.filter((item) => item.enabled).map((item) => `${prefix}:${item.catalog_id}`);
  const keys = on("tool", resolvedTools(rows, snapshot.scope));
  for (const { item, connection } of agentConnections(snapshot, rows)) {
    keys.push(...on("mcp", [item]));
    const tools = connection.tools.map((tool) => resolveMcpTool(rows, tool.name, { serverEnabled: item.enabled, ...snapshot.scope }));
    keys.push(...on("mcp_tool", tools));
  }
  return new Set(keys);
}

/** Whether the bindings after a proposal let the agent use something it cannot use before. */
function widensAccess(snapshot: Snapshot, after: Array<Record<string, unknown>>): boolean {
  const before = enabledAccess(snapshot, snapshot.rows);
  return [...enabledAccess(snapshot, after)].some((key) => !before.has(key));
}

/**
 * Checks what an access proposal asks for against the live bindings. A request
 * must change something; a review recomputes the same proposal so a binding
 * that moved since shows as a changed base.
 */
export async function reviewAccess(scope: EditScope, agentId: string, args: Record<string, unknown>, requesting: boolean): Promise<AccessReview> {
  const snapshot = await loadSnapshot(scope, agentId);
  const changes = parseChanges(snapshot, args);
  if (requesting && !changes.length) {
    throw new StudioUnprocessableError(`the proposal matches ${snapshot.agentName}'s live access; nothing to change`);
  }
  const after = rowsAfter(snapshot, changes);
  const live = render(snapshot, snapshot.rows);
  const proposed = render(snapshot, after);
  return {
    title: `Change ${snapshot.agentName}'s access`,
    target: { agent_id: snapshot.agentId, agent_name: snapshot.agentName },
    baseHash: hashOf(["access", live]),
    proposedHash: hashOf(["access", proposed]),
    live,
    proposed,
    effects: accessEffects(snapshot, after, changes),
    changes,
    widens: widensAccess(snapshot, after),
  };
}

/** Writes a reviewed proposal as agent-level overlays. */
export async function applyAccess(scope: EditScope, agentId: string, review: AccessReview): Promise<void> {
  if (!review.changes.length) {
    throw new StudioConflictError("the agent's access already matches this proposal");
  }
  const now = new Date();
  const actor = editActor(scope, { agentId });
  for (const change of review.changes) {
    if (change.setting === "inherit") {
      await scope.repo.deleteBinding(change.kind, change.id, "agent", agentId, actor);
      continue;
    }
    const existing = await scope.repo.getBinding(change.kind, change.id, "agent", agentId);
    const connectionId =
      change.kind === "mcp" && existing?.connection_id !== null && existing?.connection_id !== undefined
        ? String(existing.connection_id)
        : null;
    await scope.repo.upsertBinding(newId("bind"), change.kind, change.id, "agent", agentId, change.setting === "on", connectionId, now, actor);
  }
}
