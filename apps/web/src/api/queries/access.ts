import {
  type Query,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { ApiError, api } from "../client";
import { noteKeys } from "./notes";
import type {
  AccessBinding,
  AccessList,
  AccessRow,
  AccessTarget,
  AgentAccess,
  BindingsChange,
  BindingSwitch,
  BindingTarget,
  GithubSelectedRepository,
  GithubRepository,
  McpConnection,
  McpConnectionInput,
  McpServerAccess,
  McpToolCallResult,
  Reach,
  LookupOption,
  AccessOwner,
  ReachSubject,
  OrgServerInput,
} from "../types/access";

/**
 * Query keys of tools, logins and access lists. Identity is fixed for the page's life, so keys
 * carry no user or org.
 */
export const accessKeys = {
  accessAll: ["access"] as const,
  /** Access lists and what guilds and agents reach; an access list change refreshes all of it. */
  accessLists: ["access-lists"] as const,
  itemAccess: (target: AccessTarget) => ["access-lists", target.kind, target.id] as const,
  reach: (subject: ReachSubject) => ["access-lists", "reach", subject.type, subject.id] as const,
  access: (owner: AccessOwner) => ["access", owner.scope, owner.id] as const,
  githubRepositories: (connectionId: string) => ["github", connectionId, "repositories"] as const,
};

const accessPath = (owner: AccessOwner) =>
  owner.scope === "org"
    ? "/api/access"
    : `/api/${owner.scope}s/${encodeURIComponent(owner.id)}/access`;

/**
 * Tools and connected servers as the owner gets them. Reading it may sync server tool
 * lists, so it can be slow.
 */
export function useAccess(owner: AccessOwner) {
  return useQuery({
    queryKey: accessKeys.access(owner),
    queryFn: () => api<AgentAccess>(accessPath(owner)),
  });
}

function bindingQuery(owner: AccessOwner, target: BindingTarget): string {
  const query = new URLSearchParams({
    catalog_kind: target.kind,
    catalog_id: target.id,
    scope: owner.scope,
    scope_id: owner.id,
  });
  return `/api/bindings?${query.toString()}`;
}

/** Drops the owner's own binding so the item inherits again; one that is already gone is fine. */
async function inherit(owner: AccessOwner, target: BindingTarget): Promise<void> {
  try {
    await api(bindingQuery(owner, target), { method: "DELETE" });
  } catch (error) {
    if (!(error instanceof ApiError && error.status === 404)) throw error;
  }
}

function bind(owner: AccessOwner, target: BindingTarget, enabled: boolean) {
  return api("/api/bindings", {
    method: "PUT",
    body: {
      catalog_kind: target.kind,
      catalog_id: target.id,
      scope: owner.scope,
      scope_id: owner.id,
      enabled,
    },
  });
}

/** The item a target points at in an access payload, or undefined when it is gone. */
export function findBinding(
  access: AgentAccess,
  target: BindingTarget,
): AccessBinding | McpServerAccess | undefined {
  switch (target.kind) {
    case "native_tool":
      return access.tools.find((item) => item.name === target.id);
    case "mcp":
      return access.mcp.find((server) => server.id === target.id);
    case "mcp_tool":
      return access.mcp.flatMap((server) => server.tools).find((tool) => tool.name === target.id);
  }
}

/** A binding at one scope changes what every narrower scope inherits, so every access read refreshes. */
function useAccessRefresh() {
  const client = useQueryClient();
  return () => void client.invalidateQueries({ queryKey: accessKeys.accessAll });
}

/**
 * Switches one item for the owner. An override without a login is dropped first; when what the
 * owner then inherits already matches, nothing more is written.
 */
export function useSetBinding(owner: AccessOwner) {
  const refresh = useAccessRefresh();
  return useMutation({
    mutationFn: async ({ target, enabled, resetFirst }: BindingSwitch) => {
      if (resetFirst) {
        await inherit(owner, target);
        const inherited = findBinding(await api<AgentAccess>(accessPath(owner)), target);
        if (inherited?.enabled === enabled) return;
      }
      await bind(owner, target, enabled);
    },
    onSettled: refresh,
  });
}

/** Sets or drops the owner's binding on many items at once: "Enable all", "Reset to inherit". */
export function useBulkBindings(owner: AccessOwner) {
  const refresh = useAccessRefresh();
  return useMutation({
    mutationFn: ({ targets, enabled }: BindingsChange) =>
      Promise.all(
        targets.map((target) =>
          enabled === "inherit" ? inherit(owner, target) : bind(owner, target, enabled),
        ),
      ),
    onSettled: refresh,
  });
}

/** Signs the owner in to a server with its own login. OAuth servers answer with a URL to sign in at. */
export function useConnectServer(owner: AccessOwner) {
  const refresh = useAccessRefresh();
  return useMutation({
    mutationFn: ({ serverId, credentials }: McpConnectionInput) =>
      api<McpConnection>("/api/mcp/connections", {
        method: "POST",
        body: {
          mcp_server_id: serverId,
          owner_scope: owner.scope,
          owner_id: owner.id,
          ...credentials,
        },
      }),
    onSuccess: refresh,
  });
}

export function useDisconnectServer() {
  const refresh = useAccessRefresh();
  return useMutation({
    mutationFn: (connectionId: string) =>
      api<undefined>(`/api/mcp/connections/${encodeURIComponent(connectionId)}`, {
        method: "DELETE",
      }),
    onSuccess: refresh,
  });
}

/** Calls one listed tool on a connected login so the operator can see what it returns. */
export function callConnectionTool(
  connectionId: string,
  tool: string,
  arguments_: Record<string, unknown>,
) {
  return api<McpToolCallResult>(`/api/mcp/connections/${encodeURIComponent(connectionId)}/call`, {
    method: "POST",
    body: { tool, arguments: arguments_ },
  });
}

/** One login and the bindings that use it; `poll` re-reads it while an OAuth sign-in completes. */
export function useConnection(connectionId: string | null, poll = false) {
  return useQuery({
    queryKey: ["mcp-connection", connectionId ?? ""],
    queryFn: () =>
      api<McpConnection>(`/api/mcp/connections/${encodeURIComponent(connectionId ?? "")}`),
    enabled: Boolean(connectionId),
    refetchInterval: poll ? 1500 : false,
  });
}

/** Replaces the repositories a GitHub login's coding agents clone. */
export function useSetGithubRepositories(connectionId: string) {
  const refresh = useAccessRefresh();
  const client = useQueryClient();
  return useMutation({
    mutationFn: (repositories: GithubSelectedRepository[]) =>
      api<{ repositories: GithubSelectedRepository[] }>(
        `/api/mcp/connections/${encodeURIComponent(connectionId)}/github/selected`,
        { method: "PUT", body: { repositories } },
      ),
    onSuccess: () => {
      refresh();
      void client.invalidateQueries({
        predicate: (query) => query.queryKey[0] === "guild" && query.queryKey[2] === "repositories",
      });
    },
  });
}

/** The repositories a connected GitHub login's installation reaches; idle without a login. */
export function useGithubRepositories(connectionId: string | null) {
  return useQuery({
    queryKey: accessKeys.githubRepositories(connectionId ?? ""),
    enabled: Boolean(connectionId),
    queryFn: async () =>
      (
        await api<{ repositories: GithubRepository[] }>(
          `/api/mcp/connections/${encodeURIComponent(connectionId ?? "")}/github/repositories`,
        )
      ).repositories,
  });
}

const itemAccessPaths: Record<AccessTarget["kind"], string> = {
  note: "/api/notes",
  collection: "/api/collections",
  file: "/api/files",
};

const itemAccessPath = (target: AccessTarget) =>
  `${itemAccessPaths[target.kind]}/${encodeURIComponent(target.id)}/access`;

/** Who reaches a note, a table, or a file: its access list. */
export function useItemAccess(target: AccessTarget) {
  return useQuery({
    queryKey: accessKeys.itemAccess(target),
    queryFn: () => api<AccessList>(itemAccessPath(target)),
  });
}

/** Studio's activity and State views in any session, which list access-list changes. */
const isStudioChangeView = (query: Query) =>
  query.queryKey[0] === "studio" &&
  (query.queryKey[2] === "activity" || query.queryKey[3] === "state");

/**
 * Replaces a note's or a table's access list with the full list given. The change refreshes every
 * access list and reach, and the Studio views that record it.
 */
export function useSetItemAccess(target: AccessTarget) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (subjects: AccessRow[]) =>
      api<AccessList>(itemAccessPath(target), { method: "PUT", body: { subjects } }),
    onSuccess: (list) => {
      client.setQueryData(accessKeys.itemAccess(target), list);
      void client.invalidateQueries({ queryKey: accessKeys.accessLists });
      void client.invalidateQueries({ predicate: isStudioChangeView });
      // A Task embed resolves as its agent, so a changed list can mend or break one.
      void client.invalidateQueries({ queryKey: noteKeys.embedStatuses });
    },
  });
}

const reachPaths: Record<ReachSubject["type"], string> = {
  guild: "/api/guilds",
  agent: "/api/agents",
};

/** The notes and tables a guild's agents, or one agent, reach. */
export function useReach(subject: ReachSubject) {
  return useQuery({
    queryKey: accessKeys.reach(subject),
    queryFn: () =>
      api<Reach>(`${reachPaths[subject.type]}/${encodeURIComponent(subject.id)}/reach`),
  });
}

/** Values for a settings property, searched with the credentials a Connect form holds. */
export function lookupWithCredentials(
  serverId: string,
  property: string,
  q: string,
  credentials: Record<string, unknown>,
) {
  return api<{ options: LookupOption[] }>(
    `/api/mcp/servers/${encodeURIComponent(serverId)}/lookup`,
    { method: "POST", body: { property, q, credentials } },
  ).then((body) => body.options);
}

/** Values for a settings property, searched with a saved login. */
export function lookupWithLogin(connectionId: string, property: string, q: string) {
  return api<{ options: LookupOption[] }>(
    `/api/mcp/connections/${encodeURIComponent(connectionId)}/lookup?property=${encodeURIComponent(property)}&q=${encodeURIComponent(q)}`,
  ).then((body) => body.options);
}

/** Saves a login's settings; one that waited for them connects. */
export function useSaveSettings(connectionId: string) {
  const refresh = useAccessRefresh();
  return useMutation({
    mutationFn: (settings: Record<string, unknown>) =>
      api<McpConnection>(`/api/mcp/connections/${encodeURIComponent(connectionId)}/settings`, {
        method: "PUT",
        body: { settings },
      }),
    onSuccess: refresh,
  });
}

/** Adds a remote MCP server for the organisation alone. */
export function useAddOrgServer(orgId: string) {
  const refresh = useAccessRefresh();
  return useMutation({
    mutationFn: (input: OrgServerInput) =>
      api(`/api/orgs/${encodeURIComponent(orgId)}/mcp/servers`, { method: "POST", body: input }),
    onSuccess: refresh,
  });
}

/** Removes one of the organisation's own servers with its logins. */
export function useRemoveOrgServer(orgId: string) {
  const refresh = useAccessRefresh();
  return useMutation({
    mutationFn: (serverId: string) =>
      api(`/api/orgs/${encodeURIComponent(orgId)}/mcp/servers/${encodeURIComponent(serverId)}`, {
        method: "DELETE",
      }),
    onSuccess: refresh,
  });
}
