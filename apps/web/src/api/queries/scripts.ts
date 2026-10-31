import {
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { api } from "../client";
import type { Script } from "../types/scripts";

/**
 * Query keys of agents' scripts. Identity is fixed for the page's life, so keys carry no user or
 * org.
 */
export const scriptKeys = {
  agentScripts: (agentId: string) => ["agent", agentId, "scripts"] as const,
};

const scriptsPath = (agentId: string) => `/api/agents/${encodeURIComponent(agentId)}/scripts`;

export function useAgentScripts(agentId: string) {
  return useQuery({
    queryKey: scriptKeys.agentScripts(agentId),
    queryFn: () => api<Script[]>(scriptsPath(agentId)),
  });
}

/** Adds a script; a script with the same name is replaced. */
export function useCreateScript(agentId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (script: Omit<Script, "display_path">) =>
      api<Script>(scriptsPath(agentId), { method: "POST", body: script }),
    onSuccess: () => void client.invalidateQueries({ queryKey: scriptKeys.agentScripts(agentId) }),
  });
}

export function useDeleteScript(agentId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (name: string) =>
      api<undefined>(`${scriptsPath(agentId)}/${encodeURIComponent(name)}`, { method: "DELETE" }),
    onSuccess: () => void client.invalidateQueries({ queryKey: scriptKeys.agentScripts(agentId) }),
  });
}

/** Removes every script on the agent. */
export function useDeleteAllScripts(agentId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: () => api<undefined>(scriptsPath(agentId), { method: "DELETE" }),
    onSuccess: () => void client.invalidateQueries({ queryKey: scriptKeys.agentScripts(agentId) }),
  });
}
