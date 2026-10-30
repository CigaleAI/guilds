import {
  type QueryClient,
  useMutation,
  useQueries,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { api } from "../client";
import type {
  Agent,
  AgentDetail,
  AgentSettingsInput,
  AgentUsage,
  Machine,
  MachineInput,
  AgentHarness,
  Harness,
  HarnessCatalog,
  HarnessCheck,
  MachineUpdate,
  NewAgent,
} from "../types";

/**
 * Query keys of agents and the machines they run on. Identity is fixed for the page's life, so keys
 * carry no user or org.
 */
export const agentKeys = {
  agents: (guildId: string) => ["guild", guildId, "agents"] as const,
  /** Machines and the agents on them; any agent placement, move or deletion refreshes it. */
  machinesAll: ["machines"] as const,
  orgMachines: (orgId: string) => ["machines", orgId] as const,
  agent: (agentId: string) => ["agent", agentId] as const,
  agentHarness: (agentId: string) => ["agent", agentId, "harness"] as const,
  harnesses: ["harnesses"] as const,
  agentUsage: (agentId: string) => ["agent", agentId, "usage"] as const,
};

/** A guild's agents. Built here rather than from `guildPath`: the guilds module imports this one to refresh machines. */
const guildAgentsPath = (guildId: string) => `/api/guilds/${encodeURIComponent(guildId)}/agents`;

export function useGuildAgents(guildId: string) {
  return useQuery({
    queryKey: agentKeys.agents(guildId),
    queryFn: () => api<Agent[]>(guildAgentsPath(guildId)),
  });
}

/** Agents for every listed guild, as the sidebar shows them. */
export function useAgentsByGuild(guildIds: readonly string[]) {
  return useQueries({
    queries: guildIds.map((guildId) => ({
      queryKey: agentKeys.agents(guildId),
      queryFn: () => api<Agent[]>(guildAgentsPath(guildId)),
    })),
    combine: (results) => {
      const byGuild = new Map<string, Agent[]>();
      results.forEach((result, index) => {
        const guildId = guildIds[index];
        if (guildId && result.data) byGuild.set(guildId, result.data);
      });
      return byGuild;
    },
  });
}

export function useAgent(agentId: string) {
  return useQuery({
    queryKey: agentKeys.agent(agentId),
    queryFn: () => api<AgentDetail>(`/api/agents/${encodeURIComponent(agentId)}`),
  });
}

/** The models each harness offers, and the efforts they run at; fixed while the server runs. */
export function useHarnessCatalog() {
  return useQuery({
    queryKey: agentKeys.harnesses,
    queryFn: () => api<{ harnesses: HarnessCatalog[] }>("/api/harnesses"),
    select: (data) => data.harnesses,
    staleTime: Infinity,
  });
}

/** Each harness's credentials for the agent; read fresh, since grants and logins change elsewhere. */
export function useAgentHarness(agentId: string) {
  return useQuery({
    queryKey: agentKeys.agentHarness(agentId),
    staleTime: 0,
    queryFn: () => api<AgentHarness>(`/api/agents/${encodeURIComponent(agentId)}/harness`),
  });
}

/** Checks the agent's machine for a harness's login, waking the machine; the credentials then re-read. */
export function useCheckHarness(agentId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (harness: Harness) =>
      api<HarnessCheck>(`/api/agents/${encodeURIComponent(agentId)}/harness/check`, {
        method: "POST",
        body: { harness },
      }),
    onSettled: () => void client.invalidateQueries({ queryKey: agentKeys.agentHarness(agentId) }),
  });
}

export function useAgentUsage(agentId: string) {
  return useQuery({
    queryKey: agentKeys.agentUsage(agentId),
    queryFn: () => api<AgentUsage>(`/api/agents/${encodeURIComponent(agentId)}/usage`),
  });
}

/**
 * Saves the agent's name, model settings, machine, focus and look. Switching the browser on counts
 * against the plan's browser-agent limit; a new machine moves the agent and its home there.
 */
export function useSaveAgentSettings(agentId: string, guildId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: AgentSettingsInput) =>
      api<AgentDetail>(`/api/agents/${encodeURIComponent(agentId)}/config`, {
        method: "PUT",
        body: input,
      }),
    onSuccess: (agent) => {
      client.setQueryData(agentKeys.agent(agentId), agent);
      void client.invalidateQueries({ queryKey: agentKeys.agents(guildId) });
      void client.invalidateQueries({ queryKey: agentKeys.agentUsage(agentId) });
      void client.invalidateQueries({ queryKey: agentKeys.agentHarness(agentId) });
      refreshMachines(client);
    },
  });
}

/** Deletes the agent with its runs, routines, notes, home and usage row. */
export function useDeleteAgent(guildId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (agentId: string) =>
      api<undefined>(`/api/agents/${encodeURIComponent(agentId)}`, { method: "DELETE" }),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: agentKeys.agents(guildId) });
      refreshMachines(client);
    },
  });
}

const machinesPath = (orgId: string) => `/api/orgs/${encodeURIComponent(orgId)}/machines`;

/**
 * Refreshes every read that shows machines or the memory their agents plan to use: the machine
 * lists and the recipe apply previews.
 */
export function refreshMachines(client: QueryClient) {
  void client.invalidateQueries({ queryKey: agentKeys.machinesAll });
  void client.invalidateQueries({
    predicate: (query) => query.queryKey[0] === "recipes" && query.queryKey[2] === "preview",
  });
}

/** The organisation's machines, each with its agents, their planned load, and its disk. */
export function useOrgMachines(orgId: string) {
  return useQuery({
    queryKey: agentKeys.orgMachines(orgId),
    queryFn: () => api<Machine[]>(machinesPath(orgId)),
  });
}

/** A new machine; owners and admins only. */
export function useCreateMachine(orgId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: MachineInput) =>
      api<Machine>(machinesPath(orgId), { method: "POST", body: input }),
    onSuccess: () => refreshMachines(client),
  });
}

/**
 * Renames, resizes, or changes the disk cap of a machine; owners and admins only. A new tier or size
 * restarts the machine once none of its agents is generating.
 */
export function useUpdateMachine(orgId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ machineId, input }: MachineUpdate) =>
      api<Machine>(`${machinesPath(orgId)}/${encodeURIComponent(machineId)}`, {
        method: "PATCH",
        body: input,
      }),
    onSuccess: (machine) => {
      refreshMachines(client);
      for (const agent of machine.agents) {
        void client.invalidateQueries({ queryKey: agentKeys.agent(agent.id) });
        void client.invalidateQueries({ queryKey: agentKeys.agents(agent.guild_id) });
      }
    },
  });
}

/** Deletes a machine with no agents on it; owners and admins only. */
export function useDeleteMachine(orgId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (machineId: string) =>
      api<undefined>(`${machinesPath(orgId)}/${encodeURIComponent(machineId)}`, {
        method: "DELETE",
      }),
    onSuccess: () => refreshMachines(client),
  });
}

/** A new agent in the guild, on the machine named, or the organisation's only one; its focus seeds its Task. */
export function useCreateAgent(guildId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: NewAgent) => api<AgentDetail>(guildAgentsPath(guildId), { method: "POST", body: input }),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: agentKeys.agents(guildId) });
      refreshMachines(client);
    },
  });
}
