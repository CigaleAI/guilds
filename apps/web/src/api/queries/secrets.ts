import {
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { api } from "../client";
import type { AccessOwner } from "../types/access";
import type { NewSecret, Secret, SecretAccessUpdate, SecretUpdate } from "../types/secrets";

/** Query keys of secrets. Identity is fixed for the page's life, so keys carry no user or org. */
export const secretKeys = {
  secretsAll: ["secrets"] as const,
  secrets: (owner: AccessOwner) => ["secrets", owner.scope, owner.id] as const,
};

const secretPath = (secretId: string) => `/api/secrets/${encodeURIComponent(secretId)}`;

/**
 * The organisation's secrets for one view: all of them, what reaches a guild's agents
 * (organisation-wide, granted to the guild or to its agents), or exactly one agent's environment.
 */
export function useSecrets(owner: AccessOwner) {
  const query = owner.scope === "org" ? "" : `?${owner.scope}_id=${encodeURIComponent(owner.id)}`;
  return useQuery({
    queryKey: secretKeys.secrets(owner),
    queryFn: async () => (await api<{ secrets: Secret[] }>(`/api/secrets${query}`)).secrets,
  });
}

/** A secret change moves what every view lists and every agent's environment. */
function useSecretsRefresh() {
  const client = useQueryClient();
  return () => {
    void client.invalidateQueries({ queryKey: secretKeys.secretsAll });
    void client.invalidateQueries({ queryKey: ["agent"] });
  };
}

/** Adds a secret with its access; its value goes to the orchestrator and is never read back. */
export function useCreateSecret() {
  const refresh = useSecretsRefresh();
  return useMutation({
    mutationFn: (secret: NewSecret) =>
      api<Secret>("/api/secrets", { method: "POST", body: secret }),
    onSuccess: refresh,
  });
}

/** Renames, redescribes, or rotates a secret. */
export function useUpdateSecret() {
  const refresh = useSecretsRefresh();
  return useMutation({
    mutationFn: ({ secretId, changes }: SecretUpdate) =>
      api<Secret>(secretPath(secretId), { method: "PATCH", body: changes }),
    onSuccess: refresh,
  });
}

/** Replaces who gets a secret; org owners and admins only. */
export function useSetSecretAccess() {
  const refresh = useSecretsRefresh();
  return useMutation({
    mutationFn: ({ secretId, access }: SecretAccessUpdate) =>
      api<Secret>(`${secretPath(secretId)}/access`, { method: "PUT", body: access }),
    onSuccess: refresh,
  });
}

export function useDeleteSecret() {
  const refresh = useSecretsRefresh();
  return useMutation({
    mutationFn: (secretId: string) => api<undefined>(secretPath(secretId), { method: "DELETE" }),
    onSuccess: refresh,
  });
}
