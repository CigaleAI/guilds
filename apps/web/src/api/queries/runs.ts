import {
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { attachmentIdsOf } from "../attachments";
import { api } from "../client";
import { agentKeys } from "./agents";
import type { Run, RunDiff, HarnessLog, RunMessage, NewRun, RunMessageInput } from "../types/runs";

/** Query keys of runs. Identity is fixed for the page's life, so keys carry no user or org. */
export const runKeys = {
  agentRuns: (agentId: string) => ["agent", agentId, "runs"] as const,
  run: (runId: string) => ["run", runId] as const,
  runDiff: (runId: string, repository: string) => ["run", runId, "diff", repository] as const,
  taskDiff: (runId: string, callId: string) => ["run", runId, "task-diff", callId] as const,
  taskLog: (runId: string, callId: string) => ["run", runId, "task-log", callId] as const,
  runMessages: (runId: string) => ["run", runId, "messages"] as const,
};

const runPath = (runId: string) => `/api/runs/${encodeURIComponent(runId)}`;

/** Re-read a generating run or coach session if its stream falls silent. */
export const generatingPollMs = 2500;

/** Every run of an agent, most recently active first. */
export function useAgentRuns(agentId: string) {
  return useQuery({
    queryKey: runKeys.agentRuns(agentId),
    queryFn: () => api<Run[]>(`/api/agents/${encodeURIComponent(agentId)}/runs`),
    refetchInterval: (query) =>
      query.state.data?.some((run) => run.generating) ? generatingPollMs : false,
  });
}

export function useRun(runId: string | undefined) {
  return useQuery({
    queryKey: runKeys.run(runId ?? ""),
    queryFn: () => api<Run>(runPath(runId ?? "")),
    enabled: Boolean(runId),
    refetchInterval: (query) => (query.state.data?.generating ? generatingPollMs : false),
  });
}

/** A run's rows in order; the system prompt is seq 0. */
export function useRunMessages(runId: string | undefined) {
  return useQuery({
    queryKey: runKeys.runMessages(runId ?? ""),
    queryFn: () => api<RunMessage[]>(`${runPath(runId ?? "")}/messages`),
    enabled: Boolean(runId),
  });
}

function useRunRefresh(agentId: string) {
  const client = useQueryClient();
  return (run: Run) => {
    client.setQueryData(runKeys.run(run.id), run);
    void client.invalidateQueries({ queryKey: runKeys.runMessages(run.id) });
    void client.invalidateQueries({ queryKey: runKeys.agentRuns(agentId) });
    void client.invalidateQueries({ queryKey: agentKeys.agent(agentId) });
  };
}

/** Starts a new conversation with the agent; generation begins at once. */
export function useStartRun(agentId: string) {
  const refresh = useRunRefresh(agentId);
  return useMutation({
    mutationFn: async (input: string | NewRun) => {
      const message = typeof input === "string" ? input : input.message;
      const files = typeof input === "string" ? undefined : input.files;
      const attachment_ids = await attachmentIdsOf(files);
      return api<Run>(`/api/agents/${encodeURIComponent(agentId)}/runs`, {
        method: "POST",
        body: {
          message,
          ...(attachment_ids.length ? { attachment_ids } : {}),
        },
      });
    },
    onSuccess: refresh,
  });
}

/** Continues an active run with the operator's next message. */
export function useSendRunMessage(agentId: string) {
  const refresh = useRunRefresh(agentId);
  const client = useQueryClient();
  return useMutation({
    mutationFn: async ({ runId, content, files }: RunMessageInput) => {
      const attachment_ids = await attachmentIdsOf(files);
      return api<Run>(`${runPath(runId)}/messages`, {
        method: "POST",
        body: {
          content,
          ...(attachment_ids.length ? { attachment_ids } : {}),
        },
      });
    },
    onMutate: async ({ runId }) => {
      await client.cancelQueries({ queryKey: runKeys.run(runId) });
      const previous = client.getQueryData<Run>(runKeys.run(runId));
      if (previous) client.setQueryData(runKeys.run(runId), { ...previous, generating: true });
      return { previous };
    },
    onError: (_error, { runId }, context) => {
      if (context?.previous) client.setQueryData(runKeys.run(runId), context.previous);
    },
    onSuccess: refresh,
  });
}

/** Stops the generation in flight; resolves once it has settled. */
export function useCancelRun(agentId: string) {
  const refresh = useRunRefresh(agentId);
  const client = useQueryClient();
  return useMutation({
    mutationFn: (runId: string) =>
      api<Run | undefined>(`${runPath(runId)}/cancel`, { method: "POST" }),
    onSuccess: (run, runId) => {
      if (run) refresh(run);
      else void client.invalidateQueries({ queryKey: runKeys.run(runId) });
    },
  });
}

/** Reopens an ended run so it takes messages again. */
export function useResumeRun(agentId: string) {
  const refresh = useRunRefresh(agentId);
  return useMutation({
    mutationFn: (runId: string) => api<Run>(`${runPath(runId)}/resume`, { method: "POST" }),
    onSuccess: refresh,
  });
}

/** The diff a run made in one repository, fetched from the agent's home on demand. */
export function useRunDiff(runId: string, repository: string | null) {
  return useQuery({
    queryKey: runKeys.runDiff(runId, repository ?? ""),
    enabled: Boolean(repository),
    staleTime: Infinity,
    queryFn: () =>
      api<RunDiff>(`${runPath(runId)}/changes/${encodeURIComponent(repository ?? "")}/diff`),
  });
}

/** The diff one code task made, between its start and end checkpoints, fetched on demand. */
export function useTaskDiff(runId: string, callId: string | null) {
  return useQuery({
    queryKey: runKeys.taskDiff(runId, callId ?? ""),
    enabled: Boolean(callId),
    staleTime: Infinity,
    queryFn: () => api<RunDiff>(`${runPath(runId)}/tasks/${encodeURIComponent(callId ?? "")}/diff`),
  });
}

/** A code task's kept harness log, read from the agent's machine on demand. */
export function useTaskLog(runId: string, callId: string | null) {
  return useQuery({
    queryKey: runKeys.taskLog(runId, callId ?? ""),
    enabled: Boolean(callId),
    staleTime: Infinity,
    retry: false,
    queryFn: () =>
      api<HarnessLog>(`${runPath(runId)}/tasks/${encodeURIComponent(callId ?? "")}/log`),
  });
}
