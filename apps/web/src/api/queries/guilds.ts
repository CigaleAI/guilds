import {
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { api } from "../client";
import { refreshMachines } from "./agents";
import type {
  GuildInput,
  GuildUsage,
  Guild,
  GuildRepository,
  GithubLogin,
  RepositoryInput,
  GuildOperatorRole,
  NewGuild,
} from "../types";

/** Query keys of guilds. Identity is fixed for the page's life, so keys carry no user or org. */
export const guildKeys = {
  guilds: ["guilds"] as const,
  guild: (guildId: string) => ["guild", guildId] as const,
  guildSchedules: (guildId: string) => ["guild", guildId, "schedules"] as const,
  guildUsage: (guildId: string) => ["guild", guildId, "usage"] as const,
  guildRepositories: (guildId: string) => ["guild", guildId, "repositories"] as const,
};

export const guildPath = (guildId: string) => `/api/guilds/${encodeURIComponent(guildId)}`;

export function useGuilds() {
  return useQuery({ queryKey: guildKeys.guilds, queryFn: () => api<Guild[]>("/api/guilds") });
}

export function useGuild(guildId: string) {
  return useQuery({ queryKey: guildKeys.guild(guildId), queryFn: () => api<Guild>(guildPath(guildId)) });
}

export function useGuildUsage(guildId: string) {
  return useQuery({
    queryKey: guildKeys.guildUsage(guildId),
    queryFn: () => api<GuildUsage>(`${guildPath(guildId)}/usage`),
  });
}

/**
 * Saves guild fields; left-out ones keep their value. Turning routines back on plans overdue
 * wake-ups from now instead of firing them at once. Only a guild admin may change visibility.
 */
export function useUpdateGuild(guildId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: GuildInput) =>
      api<Guild>(guildPath(guildId), { method: "PUT", body: input }),
    onSuccess: (guild) => {
      client.setQueryData(guildKeys.guild(guildId), guild);
      void client.invalidateQueries({ queryKey: guildKeys.guilds });
      void client.invalidateQueries({ queryKey: guildKeys.guildSchedules(guildId) });
    },
  });
}

/** Adds an operator or changes their role; a guild keeps at least one admin. Admins only. */
export function useGuildRepositories(guildId: string) {
  return useQuery({
    queryKey: guildKeys.guildRepositories(guildId),
    queryFn: () =>
      api<{ repositories: GuildRepository[]; github_connections: GithubLogin[] }>(
        `${guildPath(guildId)}/repositories`,
      ),
  });
}

export function useAddGuildRepository(guildId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: RepositoryInput) =>
      api<GuildRepository>(`${guildPath(guildId)}/repositories`, { method: "POST", body: input }),
    onSuccess: () => void client.invalidateQueries({ queryKey: guildKeys.guildRepositories(guildId) }),
  });
}

export function useRemoveGuildRepository(guildId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (repositoryId: string) =>
      api<void>(`${guildPath(guildId)}/repositories/${encodeURIComponent(repositoryId)}`, {
        method: "DELETE",
      }),
    onSuccess: () => void client.invalidateQueries({ queryKey: guildKeys.guildRepositories(guildId) }),
  });
}

export function useSetOperator(guildId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ userId, role }: GuildOperatorRole) =>
      api<Guild>(`${guildPath(guildId)}/operators/${encodeURIComponent(userId)}`, {
        method: "PUT",
        body: { role },
      }),
    onSuccess: (guild) => {
      client.setQueryData(guildKeys.guild(guildId), guild);
      void client.invalidateQueries({ queryKey: guildKeys.guilds });
    },
  });
}

export function useRemoveOperator(guildId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (userId: string) =>
      api<Guild>(`${guildPath(guildId)}/operators/${encodeURIComponent(userId)}`, {
        method: "DELETE",
      }),
    onSuccess: (guild) => {
      client.setQueryData(guildKeys.guild(guildId), guild);
      void client.invalidateQueries({ queryKey: guildKeys.guilds });
    },
  });
}

/** Deletes the guild with its chat, agents, notes and agent homes. Admins only. */
export function useDeleteGuild() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (guildId: string) => api<undefined>(guildPath(guildId), { method: "DELETE" }),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: guildKeys.guilds });
      refreshMachines(client);
    },
  });
}

/** A new guild; its creator becomes its admin. Private guilds show only to their operators. */
export function useCreateGuild() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: NewGuild) => api<Guild>("/api/guilds", { method: "POST", body: { ...input, database: false } }),
    onSuccess: () => void client.invalidateQueries({ queryKey: guildKeys.guilds }),
  });
}
