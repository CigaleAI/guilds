import { loadAgentView } from "./view.js";
import { requireVisibleAgent } from "../agents/access.js";
import {
  createAgent,
  moveAgentToMachine,
  reconfigureAgent,
  type AgentRequest,
  type AgentServices,
  type AgentSettingsPatch,
} from "../agents/service.js";
import { loadOperatorActor } from "../artifacts/actors.js";
import type { AgentRow } from "../db/agents.js";
import type { UserRow } from "../db/users.js";
import { requireVisibleGuild } from "../guilds/access.js";
import type { McpPool } from "../mcp/pool.js";

/** What an agent's page writes through, and the pool its view lists the agent's tools through. */
export type AgentPageServices = AgentServices & { mcp: McpPool | null };

/** The view of `row` as its page shows it, generating while the loop runs it. */
async function loadAgentPageView(
  services: AgentPageServices,
  row: AgentRow,
): Promise<Record<string, unknown>> {
  const generating = services.generation?.isAgentBusy(row.id) ?? false;
  return loadAgentView(services.db, services.mcp, row, generating);
}

/** The page of an agent the user sees. Any other is a 404. */
export async function loadAgentPage(
  services: AgentPageServices,
  agentId: string,
  userId: string,
): Promise<Record<string, unknown>> {
  return loadAgentPageView(services, await requireVisibleAgent(services.db, agentId, userId));
}

/** Creates the agent `request` asks for in a guild the user sees, and returns its page. */
export async function createAgentFromPage(
  services: AgentPageServices,
  guildId: string,
  user: UserRow,
  request: AgentRequest,
): Promise<Record<string, unknown>> {
  const guild = await requireVisibleGuild(services.db, guildId, user.id);
  const operator = await loadOperatorActor(services.db, user, { orgId: guild.org_id });
  return loadAgentPageView(services, await createAgent(services, guild, operator, request));
}

/** Applies `patch` to an agent the user sees, and returns its page. */
export async function reconfigureAgentFromPage(
  services: AgentPageServices,
  agentId: string,
  userId: string,
  patch: AgentSettingsPatch,
): Promise<Record<string, unknown>> {
  const agent = await requireVisibleAgent(services.db, agentId, userId);
  return loadAgentPageView(services, await reconfigureAgent(services, agent, userId, patch));
}

/** Moves an agent the user sees to the machine `machineId` names, and returns its page. */
export async function moveAgentToMachineFromPage(
  services: AgentPageServices,
  agentId: string,
  userId: string,
  machineId: string | null | undefined,
): Promise<Record<string, unknown>> {
  const agent = await requireVisibleAgent(services.db, agentId, userId);
  return loadAgentPageView(services, await moveAgentToMachine(services, agent, userId, machineId));
}
