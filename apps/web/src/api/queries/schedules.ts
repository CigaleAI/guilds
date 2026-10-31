import {
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { api } from "../client";
import { guildKeys, guildPath } from "./guilds";
import type {
  GuildSchedule,
  Schedule,
  ScheduleInput,
  ScheduleUpdate,
  SchedulePause,
  GuildSchedulePause,
} from "../types/schedules";

/** Query keys of routines. Identity is fixed for the page's life, so keys carry no user or org. */
export const scheduleKeys = {
  agentSchedules: (agentId: string) => ["agent", agentId, "schedules"] as const,
};

/** The agent's routines, to name the runs they started. */
export function useAgentSchedules(agentId: string) {
  return useQuery({
    queryKey: scheduleKeys.agentSchedules(agentId),
    queryFn: () => api<Schedule[]>(schedulesPath(agentId)),
  });
}

const schedulesPath = (agentId: string) => `/api/agents/${encodeURIComponent(agentId)}/schedules`;

function useScheduleRefresh(agentId: string) {
  const client = useQueryClient();
  return () => void client.invalidateQueries({ queryKey: scheduleKeys.agentSchedules(agentId) });
}

export function useCreateSchedule(agentId: string) {
  const refresh = useScheduleRefresh(agentId);
  return useMutation({
    mutationFn: (input: ScheduleInput) =>
      api<Schedule>(schedulesPath(agentId), { method: "POST", body: input }),
    onSuccess: refresh,
  });
}

/** A new timing plans the next wake from now; a new description or instruction keeps it. */
export function useUpdateSchedule(agentId: string) {
  const refresh = useScheduleRefresh(agentId);
  return useMutation({
    mutationFn: ({ scheduleId, input }: ScheduleUpdate) =>
      api<Schedule>(`${schedulesPath(agentId)}/${encodeURIComponent(scheduleId)}`, {
        method: "PATCH",
        body: input,
      }),
    onSuccess: refresh,
  });
}

/** Pausing keeps the planned wake; resuming plans the next one from now. */
export function useSetSchedulePaused(agentId: string) {
  const refresh = useScheduleRefresh(agentId);
  return useMutation({
    mutationFn: ({ scheduleId, paused }: SchedulePause) =>
      api<Schedule>(`${schedulesPath(agentId)}/${encodeURIComponent(scheduleId)}`, {
        method: "PATCH",
        body: { paused },
      }),
    onSuccess: refresh,
  });
}

export function useDeleteSchedule(agentId: string) {
  const refresh = useScheduleRefresh(agentId);
  return useMutation({
    mutationFn: (scheduleId: string) =>
      api<undefined>(`${schedulesPath(agentId)}/${encodeURIComponent(scheduleId)}`, {
        method: "DELETE",
      }),
    onSuccess: refresh,
  });
}

/** The guild's routines, grouped by agent in the order the agents joined. */
export function useGuildSchedules(guildId: string) {
  return useQuery({
    queryKey: guildKeys.guildSchedules(guildId),
    queryFn: () => api<GuildSchedule[]>(`${guildPath(guildId)}/schedules`),
  });
}

export function useSetGuildSchedulePaused(guildId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ agentId, scheduleId, paused }: GuildSchedulePause) =>
      api<Schedule>(
        `/api/agents/${encodeURIComponent(agentId)}/schedules/${encodeURIComponent(scheduleId)}`,
        { method: "PATCH", body: { paused } },
      ),
    onSuccess: (_routine, { agentId }) => {
      void client.invalidateQueries({ queryKey: guildKeys.guildSchedules(guildId) });
      void client.invalidateQueries({ queryKey: scheduleKeys.agentSchedules(agentId) });
    },
  });
}
