import { loadAccessView } from "../access/view.js";
import { accessDatabase, agentSecrets } from "../access/runtime.js";
import type { AgentRow } from "../db/agents.js";
import { isPlainRecord, jsonObj } from "../db/json.js";
import type { Queryable } from "../db/pg.js";
import { mcpDatabase, type McpPool } from "../mcp/index.js";
import {
  addMissingBrowserLanguage,
  addMissingFlags,
  addMissingScriptingAndMemory,
  DEFAULT_KEEP_TOOL_RESULT_GENERATIONS,
  DEFAULT_MAX_SCRIPTS,
  DEFAULT_MAX_WORKSPACE_MIB,
} from "./validation.js";

function agentConfig(row: Record<string, unknown>): Record<string, unknown> {
  const value = jsonObj(row.config);
  if (isPlainRecord(value)) {
    const config = addMissingFlags(addMissingBrowserLanguage(addMissingScriptingAndMemory(value)));
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

export function agentItem(
  row: Record<string, unknown>,
  generating = false,
): Record<string, unknown> {
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

export function agentDetail(
  row: Record<string, unknown>,
  generating = false,
): Record<string, unknown> {
  return {
    ...agentItem(row, generating),
    wake_triggers: row.wake_triggers || "",
    config: agentConfig(row),
    workspace_mib:
      row.workspace_mib === null || row.workspace_mib === undefined
        ? null
        : Number(row.workspace_mib),
  };
}

export function agentConfigObject(row: Record<string, unknown>): Record<string, unknown> {
  return agentConfig(row);
}

/** An agent as its page shows it: its settings, whether it is generating, and its access with the secrets it reaches. */
export async function loadAgentView(
  db: Queryable,
  mcp: McpPool | null,
  row: AgentRow,
  generating: boolean,
): Promise<Record<string, unknown>> {
  const access = await loadAccessView(mcpDatabase(db), {
    orgId: row.org_id,
    guildId: row.guild_id,
    agentId: row.id,
    viewScope: "agent",
    mcp,
  });
  return {
    ...agentDetail(row, generating),
    access: { ...access, secrets: await agentSecrets(accessDatabase(db), row) },
  };
}
