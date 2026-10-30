import {
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { api } from "../client";
import { accessKeys } from "./access";
import type {
  CatalogServer,
  GithubAppManifestInput,
  GithubAppManifestStart,
  Instance,
  InstanceKeysInput,
  InstanceKeysRemoval,
  InstanceKeysResult,
  RegistryConnectors,
  RegistryReload,
  User,
  NewUser,
  UserEmailChange,
  CatalogServerEdit,
  CatalogToolEdit,
  RegistryAcceptance,
  RegistryConnectorAcceptance,
} from "../types";

/**
 * Query keys of this server, its catalog, its registry and its users. Identity is fixed for the
 * page's life, so keys carry no user or org.
 */
export const adminKeys = {
  users: ["users"] as const,
  instance: ["instance"] as const,
  adminCatalog: ["admin", "catalog"] as const,
  adminRegistry: ["admin", "registry"] as const,
};

/** What this server is and which integrations it has. */
export function useInstance() {
  return useQuery({
    queryKey: adminKeys.instance,
    queryFn: () => api<Instance>("/api/instance"),
    staleTime: Infinity,
  });
}

/** A platform key changes what every scope is offered, so the instance, every access read and the catalog refresh. */
export function useInstanceRefresh() {
  const client = useQueryClient();
  return () => {
    void client.invalidateQueries({ queryKey: adminKeys.instance });
    void client.invalidateQueries({ queryKey: accessKeys.accessAll });
    void client.invalidateQueries({ queryKey: adminKeys.adminCatalog });
  };
}

const instanceKeysPath = (integration: string) =>
  `/api/admin/instance/keys/${encodeURIComponent(integration)}`;

/** Enters a store integration's values; replacing the GitHub App while logins exist needs `confirmReplace`. */
export function useSaveInstanceKeys() {
  const refresh = useInstanceRefresh();
  return useMutation({
    mutationFn: ({ integration, values, confirmReplace }: InstanceKeysInput) =>
      api<InstanceKeysResult>(instanceKeysPath(integration), {
        method: "PUT",
        body: { values, ...(confirmReplace ? { confirm_replace: true } : {}) },
      }),
    onSuccess: refresh,
  });
}

/** Deletes a store integration's values; removing the GitHub App while logins exist needs `confirmReplace`. */
export function useRemoveInstanceKeys() {
  const refresh = useInstanceRefresh();
  return useMutation({
    mutationFn: ({ integration, confirmReplace }: InstanceKeysRemoval) =>
      api<InstanceKeysResult>(
        `${instanceKeysPath(integration)}${confirmReplace ? "?confirm_replace=1" : ""}`,
        { method: "DELETE" },
      ),
    onSuccess: refresh,
  });
}

/** Starts creating the GitHub App from a manifest: what the browser posts to GitHub next. */
export function useStartGithubAppManifest() {
  const refresh = useInstanceRefresh();
  return useMutation({
    mutationFn: (input: GithubAppManifestInput) =>
      api<GithubAppManifestStart>("/api/admin/instance/keys/github-app/manifest", {
        method: "POST",
        body: input,
      }),
    onSuccess: refresh,
  });
}

/** Every account on the box: the user directory, for the instance admin. */
export function useUsers() {
  return useQuery({ queryKey: adminKeys.users, queryFn: () => api<User[]>("/api/users") });
}

/** A new account, with its personal organisation. */
export function useCreateUser() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: NewUser) =>
      api<User>("/api/users", { method: "POST", body: input }),
    onSuccess: () => void client.invalidateQueries({ queryKey: adminKeys.users }),
  });
}

/** Sets the email a user signs in with behind an authenticating proxy; null clears it. */
export function useSetUserEmail() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ userId, email }: UserEmailChange) =>
      api<User>(`/api/users/${encodeURIComponent(userId)}`, { method: "PATCH", body: { email } }),
    onSuccess: () => void client.invalidateQueries({ queryKey: adminKeys.users }),
  });
}

export function useAdminCatalog() {
  return useQuery({
    queryKey: adminKeys.adminCatalog,
    queryFn: () => api<{ servers: CatalogServer[] }>("/api/admin/mcp/servers"),
    retry: false,
  });
}

function useAdminRefresh() {
  const client = useQueryClient();
  return () => void client.invalidateQueries({ queryKey: ["admin"] });
}

export function useSaveCatalogServer() {
  const refresh = useAdminRefresh();
  return useMutation({
    mutationFn: ({ id, input }: CatalogServerEdit) =>
      api(id ? `/api/admin/mcp/servers/${encodeURIComponent(id)}` : "/api/admin/mcp/servers", {
        method: id ? "PATCH" : "POST",
        body: input,
      }),
    onSuccess: refresh,
  });
}

export function useSaveCatalogTool() {
  const refresh = useAdminRefresh();
  return useMutation({
    mutationFn: ({ serverId, name, input }: CatalogToolEdit) =>
      api(
        `/api/admin/mcp/servers/${encodeURIComponent(serverId)}/tools/${encodeURIComponent(name)}`,
        { method: "PATCH", body: input },
      ),
    onSuccess: refresh,
  });
}

/** What the registry offers beside what the box has installed. */
export function useAdminRegistry() {
  return useQuery({
    queryKey: adminKeys.adminRegistry,
    queryFn: () => api<RegistryConnectors>("/api/admin/registry"),
    retry: false,
  });
}

const registryConnectorPath = (slug: string) =>
  `/api/admin/registry/connectors/${encodeURIComponent(slug)}`;

const acceptance = ({ unverified, experimental }: RegistryAcceptance) => ({
  ...(unverified ? { unverified } : {}),
  ...(experimental ? { experimental } : {}),
});

/**
 * Installs a registry connector for every organisation; an unverified one needs `unverified`, an
 * experimental one `experimental`.
 */
export function useInstallRegistryConnector() {
  const refresh = useAdminRefresh();
  return useMutation({
    mutationFn: ({ slug, ...accepted }: RegistryConnectorAcceptance) =>
      api<CatalogServer>("/api/admin/registry/connectors", {
        method: "POST",
        body: { slug, ...acceptance(accepted) },
      }),
    onSuccess: refresh,
  });
}

/** Moves an installed registry connector to the registry's newest version. */
export function useUpdateRegistryConnector() {
  const refresh = useAdminRefresh();
  return useMutation({
    mutationFn: ({ slug, ...accepted }: RegistryConnectorAcceptance) =>
      api<{ moved: Array<{ slug: string; from: string; to: string }> }>(
        `${registryConnectorPath(slug)}/update`,
        { method: "POST", body: acceptance(accepted) },
      ),
    onSuccess: refresh,
  });
}

/** Removes a registry connector with its logins and their bindings. */
export function useRemoveRegistryConnector() {
  const refresh = useAdminRefresh();
  return useMutation({
    mutationFn: (slug: string) => api(registryConnectorPath(slug), { method: "DELETE" }),
    onSuccess: refresh,
  });
}

/** Makes the running server serve the registry connectors the database and disk hold now. */
export function useReloadRegistry() {
  const refresh = useAdminRefresh();
  return useMutation({
    mutationFn: () => api<RegistryReload>("/api/admin/registry/reload", { method: "POST" }),
    onSuccess: refresh,
  });
}

/** Where the Admin tab downloads a connector in the folder format. */
export function catalogExportUrl(serverId: string): string {
  return `/api/admin/mcp/servers/${encodeURIComponent(serverId)}/export`;
}
