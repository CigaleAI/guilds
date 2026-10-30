import {
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { api } from "../client";
import type {
  OrgMember,
  Org,
  User,
  OrgUsage,
  NewMember,
  MemberRoleChange,
  OrgInput,
  ProfileChanges,
} from "../types";

/**
 * Query keys of the organisation, its members and the operator's profile. Identity is fixed for the
 * page's life, so keys carry no user or org.
 */
export const orgKeys = {
  orgMembers: (orgId: string) => ["org", orgId, "members"] as const,
  identity: ["identity"] as const,
  orgUsage: ["usage", "org"] as const,
};

export function useOrgMembers(orgId: string) {
  return useQuery({
    queryKey: orgKeys.orgMembers(orgId),
    queryFn: () => api<OrgMember[]>(`/api/orgs/${encodeURIComponent(orgId)}/members`),
  });
}

/** Adds a user to the organisation by their @name; owners add owners, admins the rest. */
export function useAddMember(orgId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ name, role }: NewMember) =>
      api<OrgMember>(`/api/orgs/${encodeURIComponent(orgId)}/members`, {
        method: "POST",
        body: { name, role },
      }),
    onSuccess: () => void client.invalidateQueries({ queryKey: orgKeys.orgMembers(orgId) }),
  });
}

/** Changes a member's role; owners change owners, admins the rest. */
export function useUpdateMemberRole(orgId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ userId, role }: MemberRoleChange) =>
      api<OrgMember>(
        `/api/orgs/${encodeURIComponent(orgId)}/members/${encodeURIComponent(userId)}`,
        { method: "PATCH", body: { role } },
      ),
    onSuccess: () => void client.invalidateQueries({ queryKey: orgKeys.orgMembers(orgId) }),
  });
}

/** Removes a member; refused while they are the only admin of a guild or the last owner. */
export function useRemoveMember(orgId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (userId: string) =>
      api<undefined>(
        `/api/orgs/${encodeURIComponent(orgId)}/members/${encodeURIComponent(userId)}`,
        { method: "DELETE" },
      ),
    onSuccess: () => void client.invalidateQueries({ queryKey: orgKeys.orgMembers(orgId) }),
  });
}

/** Renames the organisation or changes its slug; owners and admins only. */
export function useUpdateOrg(orgId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: OrgInput) =>
      api<Org>(`/api/orgs/${encodeURIComponent(orgId)}`, { method: "PATCH", body: input }),
    onSuccess: () => void client.invalidateQueries({ queryKey: orgKeys.identity }),
  });
}

/**
 * The signed-in operator's own settings: their name, the timezone new random-window routines start
 * from, and the identity colour their messages and avatar take. A field left out keeps its value.
 */
export function useUpdateProfile() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (profile: ProfileChanges) =>
      api<User>("/api/auth/me", { method: "PATCH", body: profile }),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: orgKeys.identity });
      // Every organisation's member list carries the colour.
      void client.invalidateQueries({
        predicate: (query) => query.queryKey[0] === "org" && query.queryKey[2] === "members",
      });
    },
  });
}

/** The current organisation's usage by guild and agent. */
export function useOrgUsage() {
  return useQuery({
    queryKey: orgKeys.orgUsage,
    queryFn: () => api<{ organisation: OrgUsage }>("/api/usage"),
    select: (data) => data.organisation,
  });
}
