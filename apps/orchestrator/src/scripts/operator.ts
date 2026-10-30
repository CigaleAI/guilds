import type { ArtifactActor } from "../artifacts/types.js";
import type { AgentRow } from "../db/agents.js";
import { scriptDisplayPath, scriptItem, type AgentScript, type ScriptItem, type Scripts } from "./catalog.js";

/** How an agent's scripts changed: one written, one deleted, or every one deleted. */
export type ScriptChangeAction = "create" | "delete" | "clear";

/** Scripts of an agent that changed: the agent, how, and the script's name, or null for every script. */
export type ScriptChange = { agentId: string; action: ScriptChangeAction; name: string | null };

/** What an operator's script writes run with: the scripts, and the announcement of each change. */
export type ScriptWriteDeps = {
  scripts: Scripts;
  /** Tells the agent's guild that its scripts changed; absent on a box with no guild stream. */
  publishScriptsChanged?: (guildId: string, change: ScriptChange) => Promise<void>;
};

/** The agent whose scripts an operator writes: its id, its guild, and the config that caps its scripts. */
export type ScriptAgent = Pick<AgentRow, "id" | "guild_id" | "config">;

/** The agent whose scripts an operator lists: its id and its organisation. */
export type ScriptOwner = Pick<AgentRow, "id" | "org_id">;

/** A script as an agent's operators list it: with the path it shows under in the agent's files. */
export type ListedScript = ScriptItem & { display_path: string };

/** The agent's scripts, each with the path it shows under in the agent's files. */
export async function listOperatorScripts(scripts: Scripts, agent: ScriptOwner): Promise<ListedScript[]> {
  return (await scripts.listForAgent(agent.id)).map((script) => ({
    ...scriptItem(script),
    display_path: scriptDisplayPath(agent.org_id, agent.id, script.name),
  }));
}

/** A script as an operator writes it: its name, what it does, its source, and the parameters it takes. */
export type ScriptDraft = { name: string; description: string; source: string; parameters: unknown };

/** Writes the script for the agent as `actor`, within the agent's cap, and announces it to the agent's guild. */
export async function createScript(
  deps: ScriptWriteDeps,
  actor: ArtifactActor,
  agent: ScriptAgent,
  draft: ScriptDraft,
): Promise<AgentScript> {
  const script = await deps.scripts.create(
    actor,
    agent.id,
    draft.name,
    draft.description,
    draft.source,
    draft.parameters,
    { maxScripts: agent.config.max_scripts },
  );
  await deps.publishScriptsChanged?.(agent.guild_id, { agentId: agent.id, action: "create", name: script.name });
  return script;
}

/** Deletes the agent's script of that name as `actor`, and announces it to the agent's guild. */
export async function deleteScript(
  deps: ScriptWriteDeps,
  actor: ArtifactActor,
  agent: ScriptAgent,
  name: string,
): Promise<void> {
  await deps.scripts.delete(actor, agent.id, name);
  await deps.publishScriptsChanged?.(agent.guild_id, { agentId: agent.id, action: "delete", name });
}

/** Deletes every script of the agent as `actor`, and announces it to the agent's guild. */
export async function clearScripts(deps: ScriptWriteDeps, actor: ArtifactActor, agent: ScriptAgent): Promise<void> {
  await deps.scripts.deleteAll(actor, agent.id);
  await deps.publishScriptsChanged?.(agent.guild_id, { agentId: agent.id, action: "clear", name: null });
}
