import {
  addMissingBrowserLanguage,
  addMissingFlags,
  addMissingCliScriptingAndMemory,
  DEFAULT_KEEP_TOOL_RESULT_GENERATIONS,
  DEFAULT_MAX_SCRIPTS,
  DEFAULT_MAX_WORKSPACE_MIB,
} from "../agents/validation.js";
import { formatColumnTimestamp } from "../db/codecs.js";
import { jsonObj } from "../db/json.js";
import { accessPayload } from "../access/index.js";
import { agentSecrets } from "../access/runtime.js";
import type { Repositories } from "../db/repositories.js";
import { canSeeGuild, DEFAULT_GUILD_AGENTS, guildOperators, guildRole } from "../guilds/validation.js";
import { HttpError } from "./errors.js";

function iso(value: unknown): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value !== "string") {
    throw new TypeError("timestamp must be a string");
  }
  return formatColumnTimestamp(value);
}

function agentConfig(row: Record<string, unknown>): Record<string, unknown> {
  const value = jsonObj(row.config);
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const config = addMissingFlags(
      addMissingBrowserLanguage(addMissingCliScriptingAndMemory(value as Record<string, unknown>)),
    );
    return {
      ...config,
      ...("max_scripts" in config ? {} : { max_scripts: DEFAULT_MAX_SCRIPTS }),
      ...("max_workspace_mib" in config ? {} : { max_workspace_mib: DEFAULT_MAX_WORKSPACE_MIB }),
      ...("keep_tool_result_generations" in config
        ? {}
        : { keep_tool_result_generations: DEFAULT_KEEP_TOOL_RESULT_GENERATIONS }),
    };
  }
  throw new Error("agent config must be an object");
}

export function guildItem(row: Record<string, unknown>): Record<string, unknown> {
  return {
    id: row.id,
    name: row.name,
    about: row.about || "",
    description: row.description || "",
    max_agents: Number(row.max_agents ?? DEFAULT_GUILD_AGENTS),
    git_author_email: typeof row.git_author_email === "string" ? row.git_author_email : "",
    database: false,
    archived_at: iso(row.archived_at),
    visibility: row.visibility || "org",
    operators: guildOperators(row),
    routines_enabled: row.routines_enabled !== false,
  };
}

export function agentItem(row: Record<string, unknown>, generating = false): Record<string, unknown> {
  const config = agentConfig(row);
  return {
    id: row.id,
    guild_id: row.guild_id,
    name: row.name,
    focus: row.focus || "",
    avatar_shape: row.avatar_shape || "teardrop",
    avatar_color: row.avatar_color || "#7c5cff",
    browser: Boolean(config.browser),
    coding: Boolean(config.coding),
    machine_id: row.machine_id,
    machine: { id: row.machine_id, name: row.machine_name, box: row.machine_box },
    archived_at: iso(row.archived_at),
    generating,
  };
}

export function agentDetail(row: Record<string, unknown>, generating = false): Record<string, unknown> {
  return {
    ...agentItem(row, generating),
    wake_triggers: row.wake_triggers || "",
    config: agentConfig(row),
    workspace_mib: row.workspace_mib === null || row.workspace_mib === undefined ? null : Number(row.workspace_mib),
  };
}

export function agentConfigObject(row: Record<string, unknown>): Record<string, unknown> {
  return agentConfig(row);
}

export async function ownedGuild(
  repo: Repositories,
  guildId: string,
  user: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const row = await repo.getGuild(guildId);
  if (row === null) {
    throw new HttpError(404, "guild not found");
  }
  const membership = await repo.getMembership(String(row.org_id), String(user.id));
  if (membership === null || !canSeeGuild(row, String(user.id))) {
    throw new HttpError(404, "guild not found");
  }
  return row;
}

/** A guild the user can see and administers; otherwise the same 404 as an unseen guild. */
export async function administeredGuild(
  repo: Repositories,
  guildId: string,
  user: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const row = await ownedGuild(repo, guildId, user);
  if (guildRole(row, String(user.id)) !== "admin") {
    throw new HttpError(403, "only a guild admin can do this");
  }
  return row;
}

export async function ownedAgent(
  repo: Repositories,
  agentId: string,
  user: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const row = await repo.getAgent(agentId);
  if (row === null) {
    throw new HttpError(404, "agent not found");
  }
  const membership = await repo.getMembership(String(row.org_id), String(user.id));
  if (membership === null) {
    throw new HttpError(404, "agent not found");
  }
  const guild = await repo.getGuild(String(row.guild_id));
  if (guild === null || !canSeeGuild(guild, String(user.id))) {
    throw new HttpError(404, "agent not found");
  }
  return row;
}

export async function agentWithAccess(
  repo: Repositories,
  row: Record<string, unknown>,
  options: { generating?: boolean; access?: Record<string, unknown> } = {},
): Promise<Record<string, unknown>> {
  const bindings = await repo.listBindingsCovering({
    orgId: String(row.org_id),
    guildId: String(row.guild_id),
    agentId: String(row.id),
  });
  const servers = await repo.listMcpServers(String(row.org_id));
  const connections = await repo.listMcpConnections({
    orgId: String(row.org_id),
    guildId: String(row.guild_id),
    agentId: String(row.id),
  });
  return {
    ...agentDetail(row, options.generating ?? false),
    access: {
      ...(options.access ??
        accessPayload({
          rows: bindings,
          orgId: String(row.org_id),
          guildId: String(row.guild_id),
          agentId: String(row.id),
          viewScope: "agent",
          servers,
          connections,
        })),
      secrets: await agentSecrets(repo, row),
    },
  };
}

/** A run the user may see: a member of its organisation who can see its guild. */
export async function ownedRun(
  repo: Repositories,
  runId: string,
  user: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const row = await repo.getRun(runId);
  if (row === null) {
    throw new HttpError(404, "run not found");
  }
  const agent = await repo.getAgent(String(row.agent_id));
  if (agent === null) {
    throw new HttpError(404, "run not found");
  }
  const membership = await repo.getMembership(String(agent.org_id), String(user.id));
  if (membership === null) {
    throw new HttpError(404, "run not found");
  }
  const guild = await repo.getGuild(String(agent.guild_id));
  if (guild === null || !canSeeGuild(guild, String(user.id))) {
    throw new HttpError(404, "run not found");
  }
  return row;
}
