import { accessViewDatabase, loadAccessView } from "../access/view.js";
import { accessDatabase, agentSecrets } from "../access/runtime.js";
import type { AgentRow, GuildAgentRow } from "../db/agents.js";
import type { Queryable } from "../db/pg.js";
import type { McpPool } from "../mcp/index.js";

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

/** An agent as its page shows it: its settings, whether it is generating, and its access with the secrets it reaches. */
export async function loadAgentView(
  db: Queryable,
  mcp: McpPool | null,
  row: AgentRow,
  generating: boolean,
): Promise<Record<string, unknown>> {
  const access = await loadAccessView(accessViewDatabase(db), {
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
