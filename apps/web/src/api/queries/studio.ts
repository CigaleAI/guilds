import {
  keepPreviousData,
  useMutation,
  useQueries,
  useInfiniteQuery,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { api } from "../client";
import { generatingPollMs } from "./runs";
import { tableKeys } from "./tables";
import { accessKeys } from "./access";
import type { MemoryTimeline } from "../types/notes";
import type {
  StudioAgent,
  StudioConnection,
  StudioDraft,
  StudioEdit,
  StudioInspector,
  StudioMessage,
  StudioSession,
  StateItemDetail,
  StateItemRow,
  StudioTool,
  ActivityView,
  StudioReferences,
  StudioRoutine,
  StudioRun,
  StudioMessageInput,
  NewStudioSession,
  StudioDraftAction,
  StudioEditDecision,
  StudioLoginDecision,
  StudioConnectionGrant,
  StudioToolCallsPage,
} from "../types/studio";

/** Query keys of Studio. Identity is fixed for the page's life, so keys carry no user or org. */
export const studioKeys = {
  studioReferences: (id: string) => ["artifacts", "studio-references", id] as const,
  studioSessions: ["studio", "sessions"] as const,
  studio: (id: string) => ["studio", id] as const,
  studioMessages: (id: string) => ["studio", id, "messages"] as const,
  studioInventory: (id: string) => ["studio", id, "inventory"] as const,
  studioInspector: (id: string, agentId: string) => ["studio", id, "inspector", agentId] as const,
  studioDrafts: (id: string) => ["studio", id, "drafts"] as const,
  studioEdit: (id: string, seq: number) => ["studio", id, "edit", seq] as const,
  studioConnections: (id: string) => ["studio", id, "connections"] as const,
  studioRuns: (id: string, agentId: string) => ["studio", id, "runs", agentId] as const,
  studioRoutines: (id: string, agentId: string) => ["studio", id, "routines", agentId] as const,
  studioMemory: (id: string, agentId: string) => ["studio", id, "memory", agentId] as const,
  studioActivity: (id: string, hours: number) => ["studio", id, "activity", hours] as const,
  studioTools: (id: string, hours: number) => ["studio", id, "tools", hours] as const,
  studioState: (id: string, query: Record<string, string>) => ["studio", id, "files", "state", query] as const,
  studioStateItem: (id: string, path: string, hours: number, op: string) =>
    ["studio", id, "files", "state", "item", path, hours, op] as const,
  studioToolCalls: (id: string, name: string, hours: number, errors: boolean) =>
    ["studio", id, "tools", name, "calls", hours, errors] as const,
};

const studioPath = (id: string) => `/api/studio/sessions/${encodeURIComponent(id)}`;

/** The operator's Studio sessions, newest first. */
export function useStudioSessions() {
  return useQuery({
    queryKey: studioKeys.studioSessions,
    queryFn: () => api<StudioSession[]>("/api/studio/sessions"),
  });
}

export function useStudioSession(id: string) {
  return useQuery({
    queryKey: studioKeys.studio(id),
    queryFn: () => api<StudioSession>(studioPath(id)),
    refetchInterval: (query) =>
      query.state.data && query.state.data.generation_state !== "idle" ? generatingPollMs : false,
  });
}

/**
 * Asks a pinned question in a fresh session on the same guild and coach, recorded as a child of
 * the current one, which stays open in the list.
 */
export function useAskInNewSession(parent: StudioSession) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async ({ content, focus }: StudioMessageInput) => {
      const session = await api<StudioSession>("/api/studio/sessions", {
        method: "POST",
        body: {
          mode: "optimize",
          source_guild_id: parent.source_guild_id,
          coach_config: { model: parent.coach.model, temperature: parent.coach.temperature },
          parent_session_id: parent.id,
        },
      });
      await api(`${studioPath(session.id)}/messages`, {
        method: "POST",
        body: { content, focus },
      });
      return session;
    },
    onSuccess: () => void client.invalidateQueries({ queryKey: studioKeys.studioSessions }),
  });
}

/** Starts a coach session on a guild; `parent` continues an earlier one. */
export function useCreateStudioSession() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: NewStudioSession) =>
      api<StudioSession>("/api/studio/sessions", {
        method: "POST",
        body: {
          mode: "optimize",
          source_guild_id: input.guildId,
          coach_config: { model: input.model, temperature: input.temperature },
          ...(input.parent ? { parent_session_id: input.parent } : {}),
        },
      }),
    onSuccess: () => void client.invalidateQueries({ queryKey: studioKeys.studioSessions }),
  });
}

export function useStudioMessages(id: string, generating: boolean) {
  return useQuery({
    queryKey: studioKeys.studioMessages(id),
    queryFn: () => api<StudioMessage[]>(`${studioPath(id)}/messages`),
    refetchInterval: generating ? generatingPollMs : false,
  });
}

function useStudioRefresh(id: string) {
  const client = useQueryClient();
  return () => void client.invalidateQueries({ queryKey: studioKeys.studio(id) });
}

/** Sends the operator's message, pinned to what `focus` names when given. */
export function usePostStudioMessage(id: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: StudioMessageInput) =>
      api<StudioSession>(`${studioPath(id)}/messages`, { method: "POST", body: input }),
    onMutate: async () => {
      await client.cancelQueries({ queryKey: studioKeys.studio(id) });
      const previous = client.getQueryData<StudioSession>(studioKeys.studio(id));
      if (previous) {
        client.setQueryData(studioKeys.studio(id), { ...previous, generation_state: "generating" });
      }
      return { previous };
    },
    onError: (_error, _input, context) => {
      if (context?.previous) client.setQueryData(studioKeys.studio(id), context.previous);
    },
    onSuccess: (session) => {
      client.setQueryData(studioKeys.studio(id), session);
      void client.invalidateQueries({ queryKey: studioKeys.studioMessages(id) });
    },
  });
}

export function useCancelStudio(id: string) {
  const refresh = useStudioRefresh(id);
  return useMutation({
    mutationFn: () => api(`${studioPath(id)}/cancel`, { method: "POST" }),
    onSuccess: refresh,
  });
}

/** Archives the session; it stays readable. */
export function useArchiveStudio(id: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: () => api(`${studioPath(id)}/archive`, { method: "POST" }),
    onSuccess: () => void client.invalidateQueries({ queryKey: ["studio"] }),
  });
}

/** Opens a new session carrying a summary of this one, when this one ran out of input tokens. */
export function useContinueStudio(id: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: () => api<StudioSession>(`${studioPath(id)}/continue`, { method: "POST" }),
    onSuccess: () => void client.invalidateQueries({ queryKey: studioKeys.studioSessions }),
  });
}

export function useStudioInventory(id: string, enabled: boolean) {
  return useQuery({
    queryKey: studioKeys.studioInventory(id),
    queryFn: () => api<StudioAgent[]>(`${studioPath(id)}/inventory`),
    enabled,
  });
}

/** Points the coach at one agent, or the whole guild with null. */
export function useSetStudioTarget(id: string) {
  const refresh = useStudioRefresh(id);
  return useMutation({
    mutationFn: (agentId: string | null) =>
      api<StudioSession>(`${studioPath(id)}/target`, {
        method: "PUT",
        body: { agent_id: agentId },
      }),
    onSuccess: refresh,
  });
}

export function useStudioInspector(id: string, agentId: string | null) {
  return useQuery({
    queryKey: studioKeys.studioInspector(id, agentId ?? ""),
    queryFn: () =>
      api<StudioInspector>(`${studioPath(id)}/agents/${encodeURIComponent(agentId ?? "")}`),
    enabled: Boolean(agentId),
  });
}

export function useStudioDrafts(id: string) {
  return useQuery({
    queryKey: studioKeys.studioDrafts(id),
    queryFn: () => api<StudioDraft[]>(`${studioPath(id)}/drafts`),
  });
}

const draftPath = (id: string) => `/api/studio/drafts/${encodeURIComponent(id)}`;

/** Publishes a draft as the agent's new Task; one written over a changed Task becomes conflicted. */
export function useDraftAction(sessionId: string) {
  const refresh = useStudioRefresh(sessionId);
  return useMutation({
    mutationFn: ({ draftId, action, content }: StudioDraftAction) =>
      api(`${draftPath(draftId)}/${action}`, {
        method: "POST",
        body: action === "revise" ? { proposed_content: content, expected_head_id: draftId } : {},
      }),
    onSuccess: refresh,
  });
}

/** The coach edits at these tool message seqs, in the same order. */
export function useStudioEdits(id: string, seqs: readonly number[]) {
  return useQueries({
    queries: seqs.map((seq) => ({
      queryKey: studioKeys.studioEdit(id, seq),
      queryFn: () => api<StudioEdit>(`${studioPath(id)}/edits/${seq}`),
    })),
  });
}

/** Applies or declines one coach edit; an applied table edit refreshes the databases too. */
export function useDecideEdit(id: string) {
  const client = useQueryClient();
  const refresh = useStudioRefresh(id);
  return useMutation({
    mutationFn: ({ seq, decision }: StudioEditDecision) =>
      api(`${studioPath(id)}/edits/${seq}`, { method: "POST", body: { decision } }),
    onSuccess: () => {
      refresh();
      void client.invalidateQueries({ queryKey: tableKeys.databases });
      void client.invalidateQueries({ queryKey: accessKeys.accessAll });
    },
  });
}

export function useStudioConnections(id: string) {
  return useQuery({
    queryKey: studioKeys.studioConnections(id),
    queryFn: () =>
      api<{ connections: StudioConnection[] }>(`${studioPath(id)}/connections`).then(
        (body) => body.connections,
      ),
  });
}

/** Grants or declines a login the coach asked for; the answer is kept on its request. */
export function useResolveStudioLogin(id: string) {
  const refresh = useStudioRefresh(id);
  return useMutation({
    mutationFn: ({ seq, decision }: StudioLoginDecision) =>
      api<StudioSession>(`${studioPath(id)}/logins/${seq}`, { method: "POST", body: { decision } }),
    onSuccess: refresh,
  });
}

export function useGrantStudioConnection(id: string) {
  const refresh = useStudioRefresh(id);
  return useMutation({
    mutationFn: ({ connectionId, granted }: StudioConnectionGrant) =>
      api(`${studioPath(id)}/connections/${encodeURIComponent(connectionId)}`, {
        method: "PUT",
        body: { granted },
      }),
    onSuccess: refresh,
  });
}

/** How often Studio's lists re-read while a run in them is generating; Studio does not stream them. */
const studioPollMs = 5000;

/** An agent's runs, newest first; re-read while one is generating. */
export function useStudioRuns(id: string, agentId: string) {
  return useQuery({
    queryKey: studioKeys.studioRuns(id, agentId),
    queryFn: () =>
      api<StudioRun[]>(`${studioPath(id)}/agents/${encodeURIComponent(agentId)}/runs?limit=200`),
    refetchInterval: (query) =>
      query.state.data?.some((run) => run.generating) ? studioPollMs : false,
  });
}

export function useStudioRoutines(id: string, agentId: string) {
  return useQuery({
    queryKey: studioKeys.studioRoutines(id, agentId),
    queryFn: () =>
      api<StudioRoutine[]>(`${studioPath(id)}/agents/${encodeURIComponent(agentId)}/routines`),
  });
}

/** Every version of an agent's memory, newest first, with who wrote it. */
export function useMemoryTimeline(id: string, agentId: string) {
  return useQuery({
    queryKey: studioKeys.studioMemory(id, agentId),
    queryFn: () =>
      api<MemoryTimeline>(
        `${studioPath(id)}/agents/${encodeURIComponent(agentId)}/memory-timeline`,
      ),
  });
}

/** The guild's wakes over the last `hours`; re-read while one is running. */
export function useStudioActivity(id: string, hours: number) {
  return useQuery({
    queryKey: studioKeys.studioActivity(id, hours),
    queryFn: () => api<ActivityView>(`${studioPath(id)}/activity?hours=${hours}`),
    placeholderData: keepPreviousData,
    refetchInterval: (query) =>
      query.state.data?.wakes.some((wake) => wake.running) ? studioPollMs : false,
  });
}

/** The guild's notes, tables, scripts and Memory with their changes and reads in the window. */
export function useStudioState(
  id: string,
  hours: number,
  agent: string | null,
  kind: string | null,
) {
  const query: Record<string, string> = {
    hours: String(hours),
    ...(agent ? { agent } : {}),
    ...(kind ? { kind } : {}),
  };
  return useQuery({
    queryKey: studioKeys.studioState(id, query),
    queryFn: () =>
      api<{ items: StateItemRow[] }>(`${studioPath(id)}/state?${new URLSearchParams(query)}`).then(
        (body) => body.items,
      ),
    placeholderData: keepPreviousData,
  });
}

/** One State item: who changes and reads it, and its history a page at a time. */
export function useStudioStateItem(id: string, path: string, hours: number, op: string | null) {
  return useInfiniteQuery({
    queryKey: studioKeys.studioStateItem(id, path, hours, op ?? ""),
    queryFn: ({ pageParam }) => {
      const query = new URLSearchParams({ path, hours: String(hours) });
      if (op) query.set("op", op);
      if (pageParam) query.set("cursor", pageParam);
      return api<StateItemDetail>(`${studioPath(id)}/state/item?${query}`);
    },
    initialPageParam: null,
    getNextPageParam: (page: StateItemDetail): string | null => page.next_cursor,
  });
}

/** Every tool the guild's agents are offered or called in the window. */
export function useStudioTools(id: string, hours: number) {
  return useQuery({
    queryKey: studioKeys.studioTools(id, hours),
    queryFn: () =>
      api<{ tools: StudioTool[] }>(`${studioPath(id)}/tools?hours=${hours}`).then((body) => body.tools),
    placeholderData: keepPreviousData,
  });
}

/** One tool's calls in the window, newest first, a page at a time. */
export function useStudioToolCalls(id: string, name: string, hours: number, errorsOnly: boolean) {
  return useInfiniteQuery({
    queryKey: studioKeys.studioToolCalls(id, name, hours, errorsOnly),
    queryFn: ({ pageParam }) => {
      const query = new URLSearchParams({ hours: String(hours) });
      if (errorsOnly) query.set("errors", "true");
      if (pageParam) query.set("cursor", pageParam);
      return api<StudioToolCallsPage>(
        `${studioPath(id)}/tools/${encodeURIComponent(name)}/calls?${query}`,
      );
    },
    initialPageParam: null,
    getNextPageParam: (page: StudioToolCallsPage): string | null => page.next_cursor,
  });
}

/** What each Task and file in the session's guild embeds or names; re-read when files change. */
export function useStudioReferences(id: string) {
  return useQuery({
    queryKey: studioKeys.studioReferences(id),
    queryFn: () => api<StudioReferences>(`${studioPath(id)}/references`),
  });
}
