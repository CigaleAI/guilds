import type { AgentRow, GuildAgentRow } from "../db/agents.js";

export function agentItem(row: GuildAgentRow, generating = false): Record<string, unknown> {
  return {
    id: row.id,
    guild_id: row.guild_id,
    name: row.name,
    focus: row.focus,
    avatar_shape: row.avatar_shape || "teardrop",
    avatar_color: row.avatar_color || "#7c5cff",
    browser: row.config.browser,
    coding: row.config.coding,
    machine_id: row.machine_id,
    machine: { id: row.machine_id, name: row.machine_name, box: row.machine_box },
    generating,
  };
}

export function agentDetail(row: AgentRow, generating = false): Record<string, unknown> {
  return {
    ...agentItem(row, generating),
    wake_triggers: row.wake_triggers,
    config: row.config,
    workspace_mib: row.workspace_mib,
  };
}
