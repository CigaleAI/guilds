import {
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { api } from "../client";
import { guildPath } from "./guilds";
import { chatKeys } from "./chat";
import type {
  Issue,
  IssueStatusChange,
  GuildIssueStatusChange,
} from "../types";

/** Query keys of issues. Identity is fixed for the page's life, so keys carry no user or org. */
export const issueKeys = {
  issues: (guildId: string) => ["guild", guildId, "issues"] as const,
  openIssues: (guildId: string) => ["guild", guildId, "issues", "open"] as const,
  allIssues: (guildId: string) => ["guild", guildId, "issues", "all"] as const,
};

export function useOpenIssues(guildId: string) {
  return useQuery({
    queryKey: issueKeys.openIssues(guildId),
    queryFn: () => api<Issue[]>(`${guildPath(guildId)}/issues?status=open`),
  });
}

/** Every issue of the guild, open first, then newest. */
export function useGuildIssues(guildId: string) {
  return useQuery({
    queryKey: issueKeys.allIssues(guildId),
    queryFn: () => api<Issue[]>(`${guildPath(guildId)}/issues`),
  });
}

export function useSetIssueStatus(guildId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ issueId, status }: IssueStatusChange) =>
      api<Issue>(`${guildPath(guildId)}/issues/${encodeURIComponent(issueId)}`, {
        method: "PATCH",
        body: { status },
      }),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: issueKeys.issues(guildId) });
      void client.invalidateQueries({ queryKey: chatKeys.notifications });
    },
  });
}

/** Resolves every open issue in the guild. */
export function useResolveOpenIssues(guildId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: () =>
      api<{ resolved: number }>(`${guildPath(guildId)}/issues/resolve`, { method: "POST" }),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: issueKeys.issues(guildId) });
      void client.invalidateQueries({ queryKey: chatKeys.notifications });
    },
  });
}

/** Resolves or reopens an issue from any guild, as the inbox lists them. */
export function useSetAnyIssueStatus() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ guildId, issueId, status }: GuildIssueStatusChange) =>
      api<Issue>(`${guildPath(guildId)}/issues/${encodeURIComponent(issueId)}`, {
        method: "PATCH",
        body: { status },
      }),
    onSuccess: (_issue, { guildId }) => {
      void client.invalidateQueries({ queryKey: chatKeys.notifications });
      void client.invalidateQueries({ queryKey: issueKeys.issues(guildId) });
    },
  });
}
