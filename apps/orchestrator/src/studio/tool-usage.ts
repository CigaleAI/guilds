import { memoryOf } from "../agents/validation.js";
import { jsonObj } from "../db/json.js";
import { iso } from "../db/views.js";
import { REGISTRY } from "../toolbox/index.js";
import { offeredToolNames } from "../toolbox/offered.js";
import { StudioUnprocessableError } from "./errors.js";
import { projectAgentAccess, type PreviewDeps } from "./preview.js";
import type { ActivityWindow } from "./activity.js";
import { listAgents, type AgentRow } from "../db/agents.js";
import { listGuildToolCallStats, listGuildToolCalls } from "../db/activity.js";
import type { Queryable } from "../db/pg.js";

// The guild's tools as Studio's Tools section lists them: what each agent is
// offered now, from the live access projection, beside how the agents called
// each tool in a window, from their runs' tool results. Coach calls are
// Studio messages, not agent runs, so they are not counted.

export type ToolSource = "native" | "script" | "connector";

/** A tool an agent can reach: offered now, or listed and withheld. */
export type ToolEntry = {
  name: string;
  source: ToolSource;
  group: string;
  description: string;
  /** The MCP server a connection tool belongs to. */
  serverId: string | null;
  agentId: string;
  offered: boolean;
};

export type ToolAgentUsage = {
  agent_id: string;
  offered: boolean;
  calls: number;
  errors: number;
  median_ms: number | null;
  last_at: string | null;
};

export type ToolRow = {
  name: string;
  source: ToolSource | null;
  group: string;
  description: string;
  server_id: string | null;
  /** Agents offered the tool now. */
  offered_to: string[];
  calls: number;
  errors: number;
  median_ms: number | null;
  last_at: string | null;
  /** Each agent offered the tool or calling it in the window. */
  agents: ToolAgentUsage[];
};

export const TOOL_CALLS_PAGE = 50;
// Enough of a call's arguments to recognise it; the run keeps them all.
export const TOOL_ARGUMENT_CHARS = 240;

const num = (value: unknown): number | null =>
  value === null || value === undefined || value === "" || !Number.isFinite(Number(value)) ? null : Number(value);

/** A native tool's group: the family its name starts with, such as `note` or `record`. */
export function nativeGroup(name: string): string {
  return name.split("_")[0] || name;
}

type AgentAccess = Awaited<ReturnType<typeof projectAgentAccess>>;

function nativeEntries(agent: Pick<AgentRow, "id" | "config">, access: AgentAccess): ToolEntry[] {
  const config = (jsonObj(agent.config) as Record<string, unknown> | null) ?? {};
  const offered = offeredToolNames(access.native_tools, {
    browser: Boolean(config.browser),
    coding: Boolean(config.coding),
    scripting: config.scripting !== false,
    memory: memoryOf(config),
    schedules: true,
    direct: true,
  });
  return offered.map((name) => ({
    name,
    source: "native",
    group: nativeGroup(name),
    description: REGISTRY[name]?.description ?? "",
    serverId: null,
    agentId: agent.id,
    offered: true,
  }));
}

function scriptEntries(agent: Pick<AgentRow, "id">, access: AgentAccess, scripting: boolean): ToolEntry[] {
  return access.scripts
    .filter((script) => script.parameters !== null && script.parameters !== undefined)
    .map((script) => ({
      name: String(script.name),
      source: "script",
      group: "scripts",
      description: String(script.description ?? ""),
      serverId: null,
      agentId: agent.id,
      offered: scripting,
    }));
}

function connectorEntries(agent: Pick<AgentRow, "id">, access: AgentAccess): ToolEntry[] {
  return access.connections.flatMap((connection) =>
    connection.tools.map((tool) => ({
      name: tool.name,
      source: "connector" as const,
      group: connection.server.display_name,
      description: tool.description,
      serverId: connection.server.id,
      agentId: agent.id,
      offered: connection.offered_tools.includes(tool.name),
    })),
  );
}

/** Every tool one agent is offered now, and every script or connection tool it is withheld. */
export function agentToolEntries(agent: Pick<AgentRow, "id" | "config">, access: AgentAccess): ToolEntry[] {
  const config = (jsonObj(agent.config) as Record<string, unknown> | null) ?? {};
  return [
    ...nativeEntries(agent, access),
    ...scriptEntries(agent, access, config.scripting !== false),
    ...connectorEntries(agent, access),
  ];
}

type StatRow = Record<string, unknown>;

type Totals = Pick<ToolRow, "calls" | "errors" | "median_ms" | "last_at">;

function totalsOf(stat: StatRow | undefined): Totals {
  return {
    calls: num(stat?.calls) ?? 0,
    errors: num(stat?.errors) ?? 0,
    median_ms: num(stat?.median_ms),
    last_at: stat?.last_at ? iso(stat.last_at) : null,
  };
}

/** The agents a tool row covers: each offered it, then each that called it without the offer. */
function agentUsages(entries: ToolEntry[], stats: StatRow[]): ToolAgentUsage[] {
  const offered = new Set(entries.filter((entry) => entry.offered).map((entry) => entry.agentId));
  const byAgent = new Map(stats.map((stat) => [String(stat.agent_id), stat]));
  const ids = [...new Set([...offered, ...byAgent.keys()])].sort();
  return ids.map((id) => ({ agent_id: id, offered: offered.has(id), ...totalsOf(byAgent.get(id)) }));
}

/** One tool's row from its entries and its stats; a tool no entry lists is native when registered. */
function toolRow(name: string, entries: ToolEntry[], stats: StatRow[]): ToolRow {
  const known = entries[0];
  const agents = agentUsages(entries, stats.filter((stat) => stat.agent_id !== null));
  return {
    name,
    source: known?.source ?? (REGISTRY[name] ? "native" : null),
    group: known?.group ?? nativeGroup(name),
    description: known?.description ?? REGISTRY[name]?.description ?? "",
    server_id: known?.serverId ?? null,
    offered_to: agents.filter((usage) => usage.offered).map((usage) => usage.agent_id),
    ...totalsOf(stats.find((stat) => stat.agent_id === null)),
    agents,
  };
}

/**
 * One row per tool any agent is offered or called in the window. `stats` rows with a null
 * agent_id hold a tool's totals. A tool called but no longer offered keeps its row, offered to
 * no agent.
 */
export function buildToolRows(entries: ToolEntry[], stats: StatRow[]): ToolRow[] {
  const offered = entries.filter((entry) => entry.offered).map((entry) => entry.name);
  const names = [...new Set([...offered, ...stats.map((stat) => String(stat.tool_name))])].sort();
  return names.map((name) =>
    toolRow(
      name,
      entries.filter((entry) => entry.name === name),
      stats.filter((stat) => stat.tool_name === name),
    ),
  );
}

/** The guild's tools: what each agent is offered now, and their calls in the window. */
export async function loadGuildTools(
  deps: { db: Queryable; preview: PreviewDeps },
  guildId: string,
  window: ActivityWindow,
): Promise<{ since: string; until: string; tools: ToolRow[] }> {
  const agents = await listAgents(deps.db, guildId);
  const entries = (
    await Promise.all(agents.map(async (agent) => agentToolEntries(agent, await projectAgentAccess(deps.preview, agent))))
  ).flat();
  const stats = await listGuildToolCallStats(deps.db, guildId, window.since, window.until);
  return { since: iso(window.since), until: iso(window.until), tools: buildToolRows(entries, stats) };
}

/** Which calls a page lists: only failed ones or all, after the cursor the previous page returned. */
export type ToolCallsQuery = { errorsOnly: boolean; cursor: string | null };

/** A page cursor names the last call shown: its time and message id. */
export function parseToolCursor(cursor: string | null): { at: Date; id: number } | null {
  if (!cursor) return null;
  const [at, id] = cursor.split("~");
  const date = new Date(String(at));
  if (Number.isNaN(date.getTime()) || !Number.isInteger(Number(id))) {
    throw new StudioUnprocessableError("cursor is not one this route returned");
  }
  return { at: date, id: Number(id) };
}

function argumentsPreview(raw: unknown): string {
  const text = typeof raw === "string" ? raw : "";
  return text.length > TOOL_ARGUMENT_CHARS ? `${text.slice(0, TOOL_ARGUMENT_CHARS).trimEnd()}…` : text;
}

/** One stored call as the call list shows it. */
export function viewToolCall(row: Record<string, unknown>): Record<string, unknown> {
  const error = typeof row.error === "string" && row.error ? row.error : null;
  return {
    at: iso(row.created_at),
    agent_id: String(row.agent_id),
    run_id: String(row.run_id),
    call_id: row.call_id ?? null,
    seq: num(row.seq),
    arguments: argumentsPreview(row.arguments),
    status: error ? "error" : "ok",
    error,
    duration_ms: num(row.duration_ms),
  };
}

/** One tool's calls in the window, newest first, a page at a time. */
export async function loadToolCalls(
  db: Queryable,
  guildId: string,
  request: { tool: string; window: ActivityWindow; query: ToolCallsQuery },
): Promise<{ calls: Array<Record<string, unknown>>; next_cursor: string | null }> {
  const rows = await listGuildToolCalls(db, guildId, request.tool, {
    ...request.window,
    errorsOnly: request.query.errorsOnly,
    before: parseToolCursor(request.query.cursor),
    limit: TOOL_CALLS_PAGE + 1,
  });
  const page = rows.slice(0, TOOL_CALLS_PAGE);
  const last = page.at(-1);
  return {
    calls: page.map(viewToolCall),
    next_cursor: rows.length > TOOL_CALLS_PAGE && last ? `${iso(last.created_at)}~${String(last.id)}` : null,
  };
}
