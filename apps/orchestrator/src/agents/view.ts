import type { AgentRow, GuildAgentRow } from "../db/agents.js";
import type { AgentConfig } from "../db/schema/index.js";

/** A machine as an agent payload names it. */
export type MachineRef = {
  id: GuildAgentRow["machine_id"];
  name: GuildAgentRow["machine_name"];
  box: GuildAgentRow["machine_box"];
};

/**
 * An agent as its guild's list shows it: its profile, whether it browses and codes, the machine
 * it runs on, and whether a run is generating for it right now.
 */
export type AgentItem = Pick<
  GuildAgentRow,
  "id" | "guild_id" | "name" | "focus" | "avatar_shape" | "avatar_color" | "machine_id"
> &
  Pick<AgentConfig, "browser" | "coding"> & {
    machine: MachineRef;
    generating: boolean;
  };

/** An agent as its page shows it: its list item with its wake triggers, its config, and its home's size. */
export type AgentDetail = AgentItem & Pick<AgentRow, "wake_triggers" | "config" | "workspace_mib">;

export function agentItem(row: GuildAgentRow, generating = false): AgentItem {
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

export function agentDetail(row: AgentRow, generating = false): AgentDetail {
  return {
    ...agentItem(row, generating),
    wake_triggers: row.wake_triggers,
    config: row.config,
    workspace_mib: row.workspace_mib,
  };
}
