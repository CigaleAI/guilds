import {
  addMissingBrowserLanguage,
  addMissingFlags,
  addMissingScriptingAndMemory,
  DEFAULT_KEEP_TOOL_RESULT_GENERATIONS,
  DEFAULT_MAX_SCRIPTS,
  DEFAULT_MAX_WORKSPACE_MIB,
} from "../agents/validation.js";
import { jsonObj } from "../db/json.js";
import { accessPayload } from "../access/index.js";
import { accessDatabase, agentSecrets } from "../access/runtime.js";
import { DEFAULT_GUILD_AGENTS, guildOperators } from "../guilds/validation.js";
import { listBindingsCovering } from "../db/bindings.js";
import { listMcpServers } from "../db/connectors.js";
import { listMcpConnections } from "../db/mcp.js";
import type { Queryable } from "../db/pg.js";

function agentConfig(row: Record<string, unknown>): Record<string, unknown> {
  const value = jsonObj(row.config);
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const config = addMissingFlags(
      addMissingBrowserLanguage(addMissingScriptingAndMemory(value as Record<string, unknown>)),
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




export async function agentWithAccess(
  db: Queryable,
  row: Record<string, unknown>,
  options: { generating?: boolean; access?: Record<string, unknown> } = {},
): Promise<Record<string, unknown>> {
  const bindings = await listBindingsCovering(db, {
    orgId: String(row.org_id),
    guildId: String(row.guild_id),
    agentId: String(row.id),
  });
  const servers = await listMcpServers(db, String(row.org_id));
  const connections = await listMcpConnections(db, {
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
      secrets: await agentSecrets(accessDatabase(db), row),
    },
  };
}

