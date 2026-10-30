import {
  keepPreviousData,
  type QueryClient,
  useMutation,
  useQueries,
  useInfiniteQuery,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { attachmentIdsOf } from "./attachments";
import { ApiError, api } from "./client";
import { uploadFile, type FilesPrefix } from "./files";
import type {
  AccessBinding,
  AccessList,
  AccessRow,
  AccessTarget,
  Agent,
  AgentConfig,
  AgentAccess,
  AgentDetail,
  AgentSettingsInput,
  AgentUsage,
  CatalogKind,
  CatalogServer,
  CatalogServerInput,
  CatalogToolInput,
  Collection,
  CollectionRecord,
  EmbeddableNote,
  EmbedStatus,
  FileContent,
  FileItem,
  NoteItem,
  FileChange,
  GroupChatState,
  GroupMessage,
  GuildInput,
  GuildSchedule,
  GuildUsage,
  Guild,
  GuildRepository,
  GithubLogin,
  GithubSelectedRepository,
  GithubRepository,
  GithubAppManifestStart,
  Instance,
  InstanceKeysResult,
  Issue,
  McpConnection,
  McpCredentials,
  McpToolCallResult,
  CatalogModel,
  Machine,
  MachineInput,
  NewSecret,
  Secret,
  SecretAccessChoice,
  SecretChanges,
  OrgMember,
  ModelProvider,
  OrgModelProvider,
  OrgModels,
  Notifications,
  Org,
  RecipeRow,
  Reach,
  RecordsPage,
  RegistryConnectors,
  RegistryReload,
  RegistryRecipes,
  Run,
  RunDiff,
  HarnessLog,
  RunMessage,
  Schedule,
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
  StudioToolCall,
  Script,
  ScheduleInput,
  TaskFile,
  User,
  AccessEdit,
  AccessEditResult,
  AgentHarness,
  Harness,
  HarnessCatalog,
  HarnessCheck,
  ApplyChoices,
  ApplyPreview,
  ApplyRow,
  GuildApplyState,
  ActivityView,
  StudioReferences,
  BuilderCapabilities,
  BuilderSession,
  BuilderSessionSummary,
  LookupOption,
  MemoryTimeline,
  RecipeDocument,
  RecipeValidation,
  StudioRoutine,
  StudioRun,
  OrgRole,
  OrgUsage,
  AccessOwner,
  RepositoryInput,
  RecordsQuery,
  DatabaseInput,
  ReachSubject,
  OrgServerInput,
} from "./types";

/** Query keys. Identity is fixed for the page's life, so keys carry no user or org. */
export const keys = {
  guilds: ["guilds"] as const,
  guild: (guildId: string) => ["guild", guildId] as const,
  agents: (guildId: string) => ["guild", guildId, "agents"] as const,
  chatState: (guildId: string) => ["guild", guildId, "group-chat", "state"] as const,
  chatMessages: (guildId: string) => ["guild", guildId, "group-chat", "messages"] as const,
  issues: (guildId: string) => ["guild", guildId, "issues"] as const,
  openIssues: (guildId: string) => ["guild", guildId, "issues", "open"] as const,
  allIssues: (guildId: string) => ["guild", guildId, "issues", "all"] as const,
  guildSchedules: (guildId: string) => ["guild", guildId, "schedules"] as const,
  guildUsage: (guildId: string) => ["guild", guildId, "usage"] as const,
  orgMembers: (orgId: string) => ["org", orgId, "members"] as const,
  users: ["users"] as const,
  /** Machines and the agents on them; any agent placement, move or deletion refreshes it. */
  machinesAll: ["machines"] as const,
  orgMachines: (orgId: string) => ["machines", orgId] as const,
  notifications: ["notifications"] as const,
  agent: (agentId: string) => ["agent", agentId] as const,
  agentRuns: (agentId: string) => ["agent", agentId, "runs"] as const,
  agentSchedules: (agentId: string) => ["agent", agentId, "schedules"] as const,
  agentHarness: (agentId: string) => ["agent", agentId, "harness"] as const,
  harnesses: ["harnesses"] as const,
  /** Everything read from notes, memory, Tasks and tables; a file change in any guild refreshes it. */
  artifacts: ["artifacts"] as const,
  agentTask: (agentId: string) => ["artifacts", "task", agentId] as const,
  agentMemory: (agentId: string) => ["artifacts", "memory", agentId] as const,
  embeddableNotes: ["artifacts", "embeddable-notes"] as const,
  embedStatuses: ["artifacts", "embed-status"] as const,
  embedStatus: (guildId: string) => ["artifacts", "embed-status", guildId] as const,
  studioReferences: (id: string) => ["artifacts", "studio-references", id] as const,
  latestChange: (displayPath: string) => ["artifacts", "latest-change", displayPath] as const,
  fileChanges: (displayPath: string) => ["artifacts", "changes", displayPath] as const,
  accessAll: ["access"] as const,
  agentScripts: (agentId: string) => ["agent", agentId, "scripts"] as const,
  /** Databases and their records; any database write refreshes all of it. */
  databases: ["databases"] as const,
  collection: (id: string) => ["databases", "collection", id] as const,
  records: (id: string, params: string) => ["databases", "records", id, params] as const,
  /** Access lists and what guilds and agents reach; an access list change refreshes all of it. */
  accessLists: ["access-lists"] as const,
  itemAccess: (target: AccessTarget) => ["access-lists", target.kind, target.id] as const,
  reach: (subject: ReachSubject) => ["access-lists", "reach", subject.type, subject.id] as const,
  noteList: (prefix: string) => ["artifacts", "notes", prefix] as const,
  note: (prefix: string, path: string) => ["artifacts", "note", prefix, path] as const,
  fileList: (prefix: string) => ["artifacts", "files", prefix] as const,
  agentUsage: (agentId: string) => ["agent", agentId, "usage"] as const,
  instance: ["instance"] as const,
  identity: ["identity"] as const,
  orgModels: (orgId: string) => ["org", orgId, "models"] as const,
  providerCatalog: (orgId: string, provider: string) =>
    ["org", orgId, "model-catalog", provider] as const,
  orgUsage: ["usage", "org"] as const,
  adminCatalog: ["admin", "catalog"] as const,
  adminRegistry: ["admin", "registry"] as const,
  recipes: ["recipes"] as const,
  recipeRegistry: ["registry", "recipes"] as const,
  recipe: (id: string) => ["recipes", id] as const,
  recipeValidation: (id: string, version: number) =>
    ["recipes", id, "validation", version] as const,
  recipePreview: (id: string, version: number) => ["recipes", id, "preview", version] as const,
  apply: (id: string) => ["applies", id] as const,
  guildApply: (guildId: string) => ["guilds", guildId, "apply"] as const,
  capabilities: ["capabilities"] as const,
  builderSessions: ["builder", "sessions"] as const,
  builder: (id: string) => ["builder", id] as const,
  builderMessages: (id: string) => ["builder", id, "messages"] as const,
  builderValidation: (id: string, version: number) =>
    ["builder", id, "validation", version] as const,
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
  access: (owner: { scope: string; id: string }) => ["access", owner.scope, owner.id] as const,
  secretsAll: ["secrets"] as const,
  secrets: (owner: { scope: string; id: string }) => ["secrets", owner.scope, owner.id] as const,
  run: (runId: string) => ["run", runId] as const,
  runDiff: (runId: string, repository: string) => ["run", runId, "diff", repository] as const,
  taskDiff: (runId: string, callId: string) => ["run", runId, "task-diff", callId] as const,
  taskLog: (runId: string, callId: string) => ["run", runId, "task-log", callId] as const,
  guildRepositories: (guildId: string) => ["guild", guildId, "repositories"] as const,
  githubRepositories: (connectionId: string) => ["github", connectionId, "repositories"] as const,
  runMessages: (runId: string) => ["run", runId, "messages"] as const,
};

const runPath = (runId: string) => `/api/runs/${encodeURIComponent(runId)}`;

const guildPath = (guildId: string) => `/api/guilds/${encodeURIComponent(guildId)}`;

export function useGuilds() {
  return useQuery({ queryKey: keys.guilds, queryFn: () => api<Guild[]>("/api/guilds") });
}

export function useGuild(guildId: string) {
  return useQuery({ queryKey: keys.guild(guildId), queryFn: () => api<Guild>(guildPath(guildId)) });
}

export function useGuildAgents(guildId: string) {
  return useQuery({
    queryKey: keys.agents(guildId),
    queryFn: () => api<Agent[]>(`${guildPath(guildId)}/agents`),
  });
}

/** Agents for every listed guild, as the sidebar shows them. */
export function useAgentsByGuild(guildIds: readonly string[]) {
  return useQueries({
    queries: guildIds.map((guildId) => ({
      queryKey: keys.agents(guildId),
      queryFn: () => api<Agent[]>(`${guildPath(guildId)}/agents`),
    })),
    combine: (results) => {
      const byGuild = new Map<string, Agent[]>();
      results.forEach((result, index) => {
        const guildId = guildIds[index];
        if (guildId && result.data) byGuild.set(guildId, result.data);
      });
      return byGuild;
    },
  });
}

/** Each listed guild's agents whose Task embeds something the agent cannot reach, by agent. */
export function useBrokenEmbeds(guildIds: readonly string[]) {
  return useQueries({
    queries: guildIds.map((guildId) => ({
      queryKey: keys.embedStatus(guildId),
      queryFn: () => api<EmbedStatus>(`${guildPath(guildId)}/embed-status`),
      staleTime: 60_000,
    })),
    combine: (results) => {
      const byAgent = new Map<string, string[]>();
      for (const result of results) {
        for (const agent of result.data?.agents ?? []) {
          if (agent.broken_embeds.length) byAgent.set(agent.id, agent.broken_embeds);
        }
      }
      return byAgent;
    },
  });
}

export function useAgent(agentId: string) {
  return useQuery({
    queryKey: keys.agent(agentId),
    queryFn: () => api<AgentDetail>(`/api/agents/${encodeURIComponent(agentId)}`),
  });
}

/** The models each harness offers, and the efforts they run at; fixed while the server runs. */
export function useHarnessCatalog() {
  return useQuery({
    queryKey: keys.harnesses,
    queryFn: () => api<{ harnesses: HarnessCatalog[] }>("/api/harnesses"),
    select: (data) => data.harnesses,
    staleTime: Infinity,
  });
}

/** Each harness's credentials for the agent; read fresh, since grants and logins change elsewhere. */
export function useAgentHarness(agentId: string) {
  return useQuery({
    queryKey: keys.agentHarness(agentId),
    staleTime: 0,
    queryFn: () => api<AgentHarness>(`/api/agents/${encodeURIComponent(agentId)}/harness`),
  });
}

/** Checks the agent's machine for a harness's login, waking the machine; the credentials then re-read. */
export function useCheckHarness(agentId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (harness: Harness) =>
      api<HarnessCheck>(`/api/agents/${encodeURIComponent(agentId)}/harness/check`, {
        method: "POST",
        body: { harness },
      }),
    onSettled: () => void client.invalidateQueries({ queryKey: keys.agentHarness(agentId) }),
  });
}

export function useGroupChatState(guildId: string) {
  return useQuery({
    queryKey: keys.chatState(guildId),
    queryFn: () => api<GroupChatState>(`${guildPath(guildId)}/group-chat`),
  });
}

/** The guild's whole public history, oldest first. */
export function useGroupMessages(guildId: string) {
  return useQuery({
    queryKey: keys.chatMessages(guildId),
    queryFn: () => api<GroupMessage[]>(`${guildPath(guildId)}/group-chat/messages`),
  });
}

export function useOpenIssues(guildId: string) {
  return useQuery({
    queryKey: keys.openIssues(guildId),
    queryFn: () => api<Issue[]>(`${guildPath(guildId)}/issues?status=open`),
  });
}

export function useNotifications() {
  return useQuery({
    queryKey: keys.notifications,
    queryFn: () => api<Notifications>("/api/notifications"),
  });
}

/** Reads every guild chat that tags this operator: their read cursor moves through each one. */
export function useMarkTagsRead() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: () => api<Notifications>("/api/notifications/read", { method: "POST" }),
    onSuccess: (inbox) => {
      client.setQueryData(keys.notifications, inbox);
      void client.invalidateQueries({
        predicate: (query) => query.queryKey[0] === "guild" && query.queryKey[2] === "group-chat",
      });
    },
  });
}

/**
 * Posts to the group chat; `@name` in the text tags agents and operators. `interrupt` also stops
 * the group runs the message targets.
 */
export function usePostGroupMessage(guildId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (message: { content: string; interrupt?: boolean }) =>
      api<GroupMessage>(`${guildPath(guildId)}/group-chat/messages`, {
        method: "POST",
        body: message,
      }),
    onSuccess: (message) => {
      client.setQueryData<GroupMessage[]>(keys.chatMessages(guildId), (messages) =>
        messages && !messages.some((known) => known.seq === message.seq)
          ? [...messages, message]
          : messages,
      );
      void client.invalidateQueries({ queryKey: keys.chatState(guildId) });
    },
  });
}

/** Shows a cleared group chat: no messages, and the state the clear left, keeping the read marker. */
export function showClearedGroupChat(
  client: QueryClient,
  guildId: string,
  state: GroupChatState,
): void {
  client.setQueryData<GroupMessage[]>(keys.chatMessages(guildId), []);
  client.setQueryData<GroupChatState>(keys.chatState(guildId), (previous) => ({
    ...state,
    seen_through_seq: previous?.seen_through_seq ?? null,
  }));
}

/** Deletes every group chat message for everyone in the guild; for guild admins. */
export function useClearGroupChat(guildId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: () =>
      api<GroupChatState>(`${guildPath(guildId)}/group-chat/messages`, { method: "DELETE" }),
    onSuccess: (state) => showClearedGroupChat(client, guildId, state),
  });
}

/** Moves this operator's read marker forward; the server never moves it back. */
export function useMarkGroupChatRead(guildId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (seq: number) =>
      api<{ seen_through_seq: number }>(`${guildPath(guildId)}/group-chat/read`, {
        method: "PUT",
        body: { seen_through_seq: seq },
      }),
    onSuccess: ({ seen_through_seq }) => {
      client.setQueryData<GroupChatState>(keys.chatState(guildId), (state) =>
        state ? { ...state, seen_through_seq } : state,
      );
    },
  });
}

/** Re-read a generating run or coach session if its stream falls silent. */
const generatingPollMs = 2500;

/** Every run of an agent, most recently active first. */
export function useAgentRuns(agentId: string) {
  return useQuery({
    queryKey: keys.agentRuns(agentId),
    queryFn: () => api<Run[]>(`/api/agents/${encodeURIComponent(agentId)}/runs`),
    refetchInterval: (query) =>
      query.state.data?.some((run) => run.generating) ? generatingPollMs : false,
  });
}

/** The agent's routines, to name the runs they started. */
export function useAgentSchedules(agentId: string) {
  return useQuery({
    queryKey: keys.agentSchedules(agentId),
    queryFn: () => api<Schedule[]>(schedulesPath(agentId)),
  });
}

const schedulesPath = (agentId: string) => `/api/agents/${encodeURIComponent(agentId)}/schedules`;

function useScheduleRefresh(agentId: string) {
  const client = useQueryClient();
  return () => void client.invalidateQueries({ queryKey: keys.agentSchedules(agentId) });
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
    mutationFn: ({ scheduleId, input }: { scheduleId: string; input: ScheduleInput }) =>
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
    mutationFn: ({ scheduleId, paused }: { scheduleId: string; paused: boolean }) =>
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

export function useRun(runId: string | undefined) {
  return useQuery({
    queryKey: keys.run(runId ?? ""),
    queryFn: () => api<Run>(runPath(runId ?? "")),
    enabled: Boolean(runId),
    refetchInterval: (query) => (query.state.data?.generating ? generatingPollMs : false),
  });
}

/** A run's rows in order; the system prompt is seq 0. */
export function useRunMessages(runId: string | undefined) {
  return useQuery({
    queryKey: keys.runMessages(runId ?? ""),
    queryFn: () => api<RunMessage[]>(`${runPath(runId ?? "")}/messages`),
    enabled: Boolean(runId),
  });
}

function useRunRefresh(agentId: string) {
  const client = useQueryClient();
  return (run: Run) => {
    client.setQueryData(keys.run(run.id), run);
    void client.invalidateQueries({ queryKey: keys.runMessages(run.id) });
    void client.invalidateQueries({ queryKey: keys.agentRuns(agentId) });
    void client.invalidateQueries({ queryKey: keys.agent(agentId) });
  };
}

/** Starts a new conversation with the agent; generation begins at once. */
export function useStartRun(agentId: string) {
  const refresh = useRunRefresh(agentId);
  return useMutation({
    mutationFn: async (input: string | { message: string; files?: File[] }) => {
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
    mutationFn: async ({
      runId,
      content,
      files,
    }: {
      runId: string;
      content: string;
      files?: File[];
    }) => {
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
      await client.cancelQueries({ queryKey: keys.run(runId) });
      const previous = client.getQueryData<Run>(keys.run(runId));
      if (previous) client.setQueryData(keys.run(runId), { ...previous, generating: true });
      return { previous };
    },
    onError: (_error, { runId }, context) => {
      if (context?.previous) client.setQueryData(keys.run(runId), context.previous);
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
      else void client.invalidateQueries({ queryKey: keys.run(runId) });
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

/** The agent's notes scope; its live memory and its Task are read and written by name inside it. */
export const agentNotesPrefix = (agentId: string): NotesPrefix =>
  `/api/agents/${encodeURIComponent(agentId)}/notes`;

const taskPath = (agentId: string) => `${agentNotesPrefix(agentId)}/task.md`;

export function useAgentTask(agentId: string) {
  return useQuery({
    queryKey: keys.agentTask(agentId),
    queryFn: () => api<TaskFile>(taskPath(agentId)),
  });
}

/**
 * Saves the Task. With `expected_version`, the server refuses (409) a save over a version someone
 * else wrote since; saving the same text keeps the version.
 */
export function useSaveTask(agentId: string, guildId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (body: { content: string; expected_version?: number }) =>
      api<TaskFile>(taskPath(agentId), { method: "PUT", body }),
    onSuccess: (task) => {
      client.setQueryData(keys.agentTask(agentId), task);
      void client.invalidateQueries({ queryKey: keys.embedStatus(guildId) });
      if (task.display_path)
        void client.invalidateQueries({ queryKey: keys.latestChange(task.display_path) });
    },
  });
}

/** Every version of the agent's memory, newest first; the live one has no revision id. */
export function useAgentMemory(agentId: string) {
  return useQuery({
    queryKey: keys.agentMemory(agentId),
    queryFn: () => api<MemoryTimeline>(`/api/agents/${encodeURIComponent(agentId)}/memory`),
  });
}

/**
 * Writes the agent's live memory, read with `useNote(agentNotesPrefix(agentId), "memory.md")`.
 * The server archives the text it replaces, which becomes the previous version.
 */
export function useSaveMemory(agentId: string) {
  const client = useQueryClient();
  const prefix = agentNotesPrefix(agentId);
  return useMutation({
    mutationFn: (content: string) =>
      api<FileContent>(`${prefix}/memory.md`, { method: "PUT", body: { content } }),
    onSuccess: (file) => {
      client.setQueryData(keys.note(prefix, "memory.md"), file);
      void client.invalidateQueries({ queryKey: keys.agentMemory(agentId) });
      void client.invalidateQueries({ queryKey: keys.latestChange(file.display_path) });
    },
  });
}

/** Notes the operator can read and embed, across the organisation (the server lists up to 500). */
export function useEmbeddableNotes() {
  return useQuery({
    queryKey: keys.embeddableNotes,
    queryFn: () => api<EmbeddableNote[]>("/api/org/embeddable-notes"),
  });
}

/** One note by display path, for a note the list did not include; 404 when it no longer resolves. */
export function useEmbeddableNote(displayPath: string | null, enabled: boolean) {
  return useQuery({
    queryKey: [...keys.embeddableNotes, displayPath ?? ""],
    queryFn: () =>
      api<Pick<EmbeddableNote, "display_path" | "title" | "level" | "content">>(
        `/api/org/embeddable-notes?display_path=${encodeURIComponent(displayPath ?? "")}`,
      ),
    enabled: Boolean(displayPath) && enabled,
  });
}

/** The organisation's databases, for embedding one in a Task or note. */
export function useCollections() {
  return useDatabases();
}

export function useEmbedStatus(guildId: string) {
  return useQuery({
    queryKey: keys.embedStatus(guildId),
    queryFn: () => api<EmbedStatus>(`/api/guilds/${encodeURIComponent(guildId)}/embed-status`),
  });
}

/** The newest recorded change to a file, or null when none is recorded. */
export function useLatestChange(displayPath: string | undefined) {
  return useQuery({
    queryKey: keys.latestChange(displayPath ?? ""),
    queryFn: async () => {
      const path = displayPath ?? "";
      const latest = await api<Record<string, FileChange | undefined>>(
        `/api/file-changes/latest?display_paths=${encodeURIComponent(path)}`,
      );
      return latest[path] ?? null;
    },
    enabled: Boolean(displayPath),
  });
}

/** Every recorded change to a file, newest first. */
export function useFileChanges(displayPath: string | undefined) {
  return useQuery({
    queryKey: keys.fileChanges(displayPath ?? ""),
    queryFn: () =>
      api<FileChange[]>(`/api/file-changes?display_path=${encodeURIComponent(displayPath ?? "")}`),
    enabled: Boolean(displayPath),
  });
}

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
    queryKey: keys.access(owner),
    queryFn: () => api<AgentAccess>(accessPath(owner)),
  });
}

type BindingRef = { kind: CatalogKind; id: string };

function bindingQuery(owner: AccessOwner, target: BindingRef): string {
  const query = new URLSearchParams({
    catalog_kind: target.kind,
    catalog_id: target.id,
    scope: owner.scope,
    scope_id: owner.id,
  });
  return `/api/bindings?${query.toString()}`;
}

/** Drops the owner's own binding so the item inherits again; one that is already gone is fine. */
async function inherit(owner: AccessOwner, target: BindingRef): Promise<void> {
  try {
    await api(bindingQuery(owner, target), { method: "DELETE" });
  } catch (error) {
    if (!(error instanceof ApiError && error.status === 404)) throw error;
  }
}

function bind(owner: AccessOwner, target: BindingRef, enabled: boolean) {
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

/** A binding at one scope changes what every narrower scope inherits, so every access read refreshes. */
function useAccessRefresh() {
  const client = useQueryClient();
  return () => void client.invalidateQueries({ queryKey: keys.accessAll });
}

/**
 * Switches one item for the owner. An override without a login is dropped first; when what the
 * owner then inherits already matches, nothing more is written.
 */
export function useSetBinding(owner: AccessOwner) {
  const refresh = useAccessRefresh();
  return useMutation({
    mutationFn: async ({
      target,
      enabled,
      resetFirst,
      find,
    }: {
      target: BindingRef;
      enabled: boolean;
      resetFirst: boolean;
      find: (access: AgentAccess) => Pick<AccessBinding, "enabled"> | undefined;
    }) => {
      if (resetFirst) {
        await inherit(owner, target);
        const inherited = find(await api<AgentAccess>(accessPath(owner)));
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
    mutationFn: ({ targets, enabled }: { targets: BindingRef[]; enabled: boolean | "inherit" }) =>
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
    mutationFn: ({ serverId, credentials }: { serverId: string; credentials: McpCredentials }) =>
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

const secretPath = (secretId: string) => `/api/secrets/${encodeURIComponent(secretId)}`;

/**
 * The organisation's secrets for one view: all of them, what reaches a guild's agents
 * (organisation-wide, granted to the guild or to its agents), or exactly one agent's environment.
 */
export function useSecrets(owner: AccessOwner) {
  const query = owner.scope === "org" ? "" : `?${owner.scope}_id=${encodeURIComponent(owner.id)}`;
  return useQuery({
    queryKey: keys.secrets(owner),
    queryFn: async () => (await api<{ secrets: Secret[] }>(`/api/secrets${query}`)).secrets,
  });
}

/** A secret change moves what every view lists and every agent's environment. */
function useSecretsRefresh() {
  const client = useQueryClient();
  return () => {
    void client.invalidateQueries({ queryKey: keys.secretsAll });
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
    mutationFn: ({ secretId, changes }: { secretId: string; changes: SecretChanges }) =>
      api<Secret>(secretPath(secretId), { method: "PATCH", body: changes }),
    onSuccess: refresh,
  });
}

/** Replaces who gets a secret; org owners and admins only. */
export function useSetSecretAccess() {
  const refresh = useSecretsRefresh();
  return useMutation({
    mutationFn: ({ secretId, access }: { secretId: string; access: SecretAccessChoice }) =>
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

export function useAgentUsage(agentId: string) {
  return useQuery({
    queryKey: keys.agentUsage(agentId),
    queryFn: () => api<AgentUsage>(`/api/agents/${encodeURIComponent(agentId)}/usage`),
  });
}

/** What this server is and which integrations it has. */
export function useInstance() {
  return useQuery({
    queryKey: keys.instance,
    queryFn: () => api<Instance>("/api/instance"),
    staleTime: Infinity,
  });
}

/** A platform key changes what every scope is offered, so the instance, every access read and the catalog refresh. */
export function useInstanceRefresh() {
  const client = useQueryClient();
  return () => {
    void client.invalidateQueries({ queryKey: keys.instance });
    void client.invalidateQueries({ queryKey: keys.accessAll });
    void client.invalidateQueries({ queryKey: keys.adminCatalog });
  };
}

const instanceKeysPath = (integration: string) =>
  `/api/admin/instance/keys/${encodeURIComponent(integration)}`;

/** Enters a store integration's values; replacing the GitHub App while logins exist needs `confirmReplace`. */
export function useSaveInstanceKeys() {
  const refresh = useInstanceRefresh();
  return useMutation({
    mutationFn: ({
      integration,
      values,
      confirmReplace,
    }: {
      integration: string;
      values: Record<string, string>;
      confirmReplace?: boolean;
    }) =>
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
    mutationFn: ({
      integration,
      confirmReplace,
    }: {
      integration: string;
      confirmReplace?: boolean;
    }) =>
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
    mutationFn: (input: { name?: string; owner?: string; return_to?: string }) =>
      api<GithubAppManifestStart>("/api/admin/instance/keys/github-app/manifest", {
        method: "POST",
        body: input,
      }),
    onSuccess: refresh,
  });
}

/**
 * Saves the agent's name, model settings, machine, focus and look. Switching the browser on counts
 * against the plan's browser-agent limit; a new machine moves the agent and its home there.
 */
export function useSaveAgentSettings(agentId: string, guildId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: AgentSettingsInput) =>
      api<AgentDetail>(`/api/agents/${encodeURIComponent(agentId)}/config`, {
        method: "PUT",
        body: input,
      }),
    onSuccess: (agent) => {
      client.setQueryData(keys.agent(agentId), agent);
      void client.invalidateQueries({ queryKey: keys.agents(guildId) });
      void client.invalidateQueries({ queryKey: keys.agentUsage(agentId) });
      void client.invalidateQueries({ queryKey: keys.agentHarness(agentId) });
      refreshMachines(client);
    },
  });
}

/** Deletes the agent with its runs, routines, notes, home and usage row. */
export function useDeleteAgent(guildId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (agentId: string) =>
      api<undefined>(`/api/agents/${encodeURIComponent(agentId)}`, { method: "DELETE" }),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: keys.agents(guildId) });
      refreshMachines(client);
    },
  });
}

/** Every issue of the guild, open first, then newest. */
export function useGuildIssues(guildId: string) {
  return useQuery({
    queryKey: keys.allIssues(guildId),
    queryFn: () => api<Issue[]>(`${guildPath(guildId)}/issues`),
  });
}

export function useSetIssueStatus(guildId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ issueId, status }: { issueId: string; status: Issue["status"] }) =>
      api<Issue>(`${guildPath(guildId)}/issues/${encodeURIComponent(issueId)}`, {
        method: "PATCH",
        body: { status },
      }),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: keys.issues(guildId) });
      void client.invalidateQueries({ queryKey: keys.notifications });
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
      void client.invalidateQueries({ queryKey: keys.issues(guildId) });
      void client.invalidateQueries({ queryKey: keys.notifications });
    },
  });
}

/** The guild's routines, grouped by agent in the order the agents joined. */
export function useGuildSchedules(guildId: string) {
  return useQuery({
    queryKey: keys.guildSchedules(guildId),
    queryFn: () => api<GuildSchedule[]>(`${guildPath(guildId)}/schedules`),
  });
}

export function useSetGuildSchedulePaused(guildId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({
      agentId,
      scheduleId,
      paused,
    }: {
      agentId: string;
      scheduleId: string;
      paused: boolean;
    }) =>
      api<Schedule>(
        `/api/agents/${encodeURIComponent(agentId)}/schedules/${encodeURIComponent(scheduleId)}`,
        { method: "PATCH", body: { paused } },
      ),
    onSuccess: (_routine, { agentId }) => {
      void client.invalidateQueries({ queryKey: keys.guildSchedules(guildId) });
      void client.invalidateQueries({ queryKey: keys.agentSchedules(agentId) });
    },
  });
}

export function useGuildUsage(guildId: string) {
  return useQuery({
    queryKey: keys.guildUsage(guildId),
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
      client.setQueryData(keys.guild(guildId), guild);
      void client.invalidateQueries({ queryKey: keys.guilds });
      void client.invalidateQueries({ queryKey: keys.guildSchedules(guildId) });
    },
  });
}

/** How many agent messages in a row the group chat takes before an operator must post. */
export function useSetMessageLimit(guildId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (limit: number) =>
      api<GroupChatState>(`${guildPath(guildId)}/group-chat`, {
        method: "PUT",
        body: { agent_message_limit: limit },
      }),
    onSuccess: () => void client.invalidateQueries({ queryKey: keys.chatState(guildId) }),
  });
}

export function useOrgMembers(orgId: string) {
  return useQuery({
    queryKey: keys.orgMembers(orgId),
    queryFn: () => api<OrgMember[]>(`/api/orgs/${encodeURIComponent(orgId)}/members`),
  });
}

const machinesPath = (orgId: string) => `/api/orgs/${encodeURIComponent(orgId)}/machines`;

/**
 * Refreshes every read that shows machines or the memory their agents plan to use: the machine
 * lists and the recipe apply previews.
 */
function refreshMachines(client: QueryClient) {
  void client.invalidateQueries({ queryKey: keys.machinesAll });
  void client.invalidateQueries({
    predicate: (query) => query.queryKey[0] === "recipes" && query.queryKey[2] === "preview",
  });
}

/** The organisation's machines, each with its agents, their planned load, and its disk. */
export function useOrgMachines(orgId: string) {
  return useQuery({
    queryKey: keys.orgMachines(orgId),
    queryFn: () => api<Machine[]>(machinesPath(orgId)),
  });
}

/** A new machine; owners and admins only. */
export function useCreateMachine(orgId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: MachineInput) =>
      api<Machine>(machinesPath(orgId), { method: "POST", body: input }),
    onSuccess: () => refreshMachines(client),
  });
}

/**
 * Renames, resizes, or changes the disk cap of a machine; owners and admins only. A new tier or size
 * restarts the machine once none of its agents is generating.
 */
export function useUpdateMachine(orgId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ machineId, input }: { machineId: string; input: Partial<MachineInput> }) =>
      api<Machine>(`${machinesPath(orgId)}/${encodeURIComponent(machineId)}`, {
        method: "PATCH",
        body: input,
      }),
    onSuccess: (machine) => {
      refreshMachines(client);
      for (const agent of machine.agents) {
        void client.invalidateQueries({ queryKey: keys.agent(agent.id) });
        void client.invalidateQueries({ queryKey: keys.agents(agent.guild_id) });
      }
    },
  });
}

/** Deletes a machine with no agents on it; owners and admins only. */
export function useDeleteMachine(orgId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (machineId: string) =>
      api<undefined>(`${machinesPath(orgId)}/${encodeURIComponent(machineId)}`, {
        method: "DELETE",
      }),
    onSuccess: () => refreshMachines(client),
  });
}

/** Adds an operator or changes their role; a guild keeps at least one admin. Admins only. */
export function useGuildRepositories(guildId: string) {
  return useQuery({
    queryKey: keys.guildRepositories(guildId),
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
    onSuccess: () => void client.invalidateQueries({ queryKey: keys.guildRepositories(guildId) }),
  });
}

export function useRemoveGuildRepository(guildId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (repositoryId: string) =>
      api<void>(`${guildPath(guildId)}/repositories/${encodeURIComponent(repositoryId)}`, {
        method: "DELETE",
      }),
    onSuccess: () => void client.invalidateQueries({ queryKey: keys.guildRepositories(guildId) }),
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
    queryKey: keys.githubRepositories(connectionId ?? ""),
    enabled: Boolean(connectionId),
    queryFn: async () =>
      (
        await api<{ repositories: GithubRepository[] }>(
          `/api/mcp/connections/${encodeURIComponent(connectionId ?? "")}/github/repositories`,
        )
      ).repositories,
  });
}

/** The diff a run made in one repository, fetched from the agent's home on demand. */
export function useRunDiff(runId: string, repository: string | null) {
  return useQuery({
    queryKey: keys.runDiff(runId, repository ?? ""),
    enabled: Boolean(repository),
    staleTime: Infinity,
    queryFn: () =>
      api<RunDiff>(`${runPath(runId)}/changes/${encodeURIComponent(repository ?? "")}/diff`),
  });
}

/** The diff one code task made, between its start and end checkpoints, fetched on demand. */
export function useTaskDiff(runId: string, callId: string | null) {
  return useQuery({
    queryKey: keys.taskDiff(runId, callId ?? ""),
    enabled: Boolean(callId),
    staleTime: Infinity,
    queryFn: () => api<RunDiff>(`${runPath(runId)}/tasks/${encodeURIComponent(callId ?? "")}/diff`),
  });
}

/** A code task's kept harness log, read from the agent's machine on demand. */
export function useTaskLog(runId: string, callId: string | null) {
  return useQuery({
    queryKey: keys.taskLog(runId, callId ?? ""),
    enabled: Boolean(callId),
    staleTime: Infinity,
    retry: false,
    queryFn: () =>
      api<HarnessLog>(`${runPath(runId)}/tasks/${encodeURIComponent(callId ?? "")}/log`),
  });
}

export function useSetOperator(guildId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ userId, role }: { userId: string; role: "admin" | "operator" }) =>
      api<Guild>(`${guildPath(guildId)}/operators/${encodeURIComponent(userId)}`, {
        method: "PUT",
        body: { role },
      }),
    onSuccess: (guild) => {
      client.setQueryData(keys.guild(guildId), guild);
      void client.invalidateQueries({ queryKey: keys.guilds });
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
      client.setQueryData(keys.guild(guildId), guild);
      void client.invalidateQueries({ queryKey: keys.guilds });
    },
  });
}

/** Deletes the guild with its chat, agents, notes and agent homes. Admins only. */
export function useDeleteGuild() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (guildId: string) => api<undefined>(guildPath(guildId), { method: "DELETE" }),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: keys.guilds });
      refreshMachines(client);
    },
  });
}

/** A notes scope's API root: `/api/agents/notes`, `/api/guilds/notes` or `/api/org/notes`. */
export type NotesPrefix = string;

function filePath(prefix: NotesPrefix, path: string): string {
  return `${prefix}/${path.split("/").map(encodeURIComponent).join("/")}`;
}

/** A scope's notes, or nothing when there is no scope. */
export function useNoteList(prefix: NotesPrefix | null) {
  return useQuery({
    queryKey: keys.noteList(prefix ?? ""),
    queryFn: () => api<NoteItem[]>(prefix ?? ""),
    enabled: Boolean(prefix),
  });
}

export function useNote(prefix: NotesPrefix, path: string | null) {
  return useQuery({
    queryKey: keys.note(prefix, path ?? ""),
    queryFn: () => api<FileContent>(filePath(prefix, path ?? "")),
    enabled: Boolean(path),
  });
}

/**
 * Writes a note, creating it when new. Notes are last-writer-wins: a save replaces whatever is
 * there.
 */
export function useSaveNote(prefix: NotesPrefix) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ path, content }: { path: string; content: string }) =>
      api<FileContent>(filePath(prefix, path), { method: "PUT", body: { content } }),
    onSuccess: (file, { path }) => {
      client.setQueryData(keys.note(prefix, path), file);
      void client.invalidateQueries({ queryKey: keys.noteList(prefix) });
      void client.invalidateQueries({ queryKey: keys.embeddableNotes });
      void client.invalidateQueries({ queryKey: keys.latestChange(file.display_path) });
    },
  });
}

/** Deletes a note; the server refuses one a Task still embeds. */
export function useDeleteNote(prefix: NotesPrefix) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (path: string) => api<undefined>(filePath(prefix, path), { method: "DELETE" }),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: keys.noteList(prefix) });
      void client.invalidateQueries({ queryKey: keys.embeddableNotes });
    },
  });
}

/** A scope's shared files, or nothing when there is no scope. */
export function useFileList(prefix: FilesPrefix | null) {
  return useQuery({
    queryKey: keys.fileList(prefix ?? ""),
    queryFn: () => api<FileItem[]>(prefix ?? ""),
    enabled: Boolean(prefix),
  });
}

/** Stores a file under a scope; a file of the same name there is replaced. */
export function useUploadFile(prefix: FilesPrefix) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ file, description }: { file: File; description: string }) => uploadFile(prefix, file, description),
    onSuccess: (item) => {
      void client.invalidateQueries({ queryKey: keys.fileList(prefix) });
      void client.invalidateQueries({ queryKey: keys.latestChange(item.display_path) });
    },
  });
}

/** Deletes a shared file by id and refreshes the scope it was listed in. */
export function useDeleteFile(prefix: FilesPrefix) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api<undefined>(`/api/files/${encodeURIComponent(id)}`, { method: "DELETE" }),
    onSuccess: () => void client.invalidateQueries({ queryKey: keys.fileList(prefix) }),
  });
}

/** Resolves or reopens an issue from any guild, as the inbox lists them. */
export function useSetAnyIssueStatus() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({
      guildId,
      issueId,
      status,
    }: {
      guildId: string;
      issueId: string;
      status: Issue["status"];
    }) =>
      api<Issue>(`${guildPath(guildId)}/issues/${encodeURIComponent(issueId)}`, {
        method: "PATCH",
        body: { status },
      }),
    onSuccess: (_issue, { guildId }) => {
      void client.invalidateQueries({ queryKey: keys.notifications });
      void client.invalidateQueries({ queryKey: keys.issues(guildId) });
    },
  });
}

/** A new guild; its creator becomes its admin. Private guilds show only to their operators. */
export function useCreateGuild() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: {
      name: string;
      about: string;
      description: string;
      visibility: Guild["visibility"];
    }) => api<Guild>("/api/guilds", { method: "POST", body: { ...input, database: false } }),
    onSuccess: () => void client.invalidateQueries({ queryKey: keys.guilds }),
  });
}

/** A new agent in the guild, on the machine named, or the organisation's only one; its focus seeds its Task. */
export function useCreateAgent(guildId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: {
      name: string;
      focus: string;
      avatar_shape: string;
      avatar_color: string;
      config: AgentConfig;
      machine_id?: string;
    }) => api<AgentDetail>(`${guildPath(guildId)}/agents`, { method: "POST", body: input }),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: keys.agents(guildId) });
      refreshMachines(client);
    },
  });
}

const scriptsPath = (agentId: string) => `/api/agents/${encodeURIComponent(agentId)}/scripts`;

export function useAgentScripts(agentId: string) {
  return useQuery({
    queryKey: keys.agentScripts(agentId),
    queryFn: () => api<Script[]>(scriptsPath(agentId)),
  });
}

/** Adds a script; a script with the same name is replaced. */
export function useCreateScript(agentId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (script: Omit<Script, "display_path">) =>
      api<Script>(scriptsPath(agentId), { method: "POST", body: script }),
    onSuccess: () => void client.invalidateQueries({ queryKey: keys.agentScripts(agentId) }),
  });
}

export function useDeleteScript(agentId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (name: string) =>
      api<undefined>(`${scriptsPath(agentId)}/${encodeURIComponent(name)}`, { method: "DELETE" }),
    onSuccess: () => void client.invalidateQueries({ queryKey: keys.agentScripts(agentId) }),
  });
}

/** Removes every script on the agent. */
export function useDeleteAllScripts(agentId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: () => api<undefined>(scriptsPath(agentId), { method: "DELETE" }),
    onSuccess: () => void client.invalidateQueries({ queryKey: keys.agentScripts(agentId) }),
  });
}

const collectionPath = (id: string) => `/api/collections/${encodeURIComponent(id)}`;

/** Every database in the organisation, by name, with its record count. */
export function useDatabases() {
  return useQuery({
    queryKey: keys.databases,
    queryFn: () => api<Collection[]>("/api/collections"),
  });
}

/** One database. */
export function useDatabase(id: string | undefined) {
  return useQuery({
    queryKey: keys.collection(id ?? ""),
    queryFn: () => api<Collection>(collectionPath(id ?? "")),
    enabled: Boolean(id),
  });
}

export function useRecords(id: string | undefined, query: RecordsQuery) {
  const params = new URLSearchParams({ limit: String(query.limit) });
  if (query.query) params.set("query", query.query);
  else {
    params.set("offset", String(query.offset));
    if (query.order) params.set("order", JSON.stringify(query.order));
    if (query.where && Object.keys(query.where).length)
      params.set("where", JSON.stringify(query.where));
  }
  const search = params.toString();
  return useQuery({
    queryKey: keys.records(id ?? "", search),
    queryFn: () => api<RecordsPage>(`${collectionPath(id ?? "")}/records?${search}`),
    enabled: Boolean(id),
    placeholderData: (previous) => previous,
  });
}

function useDatabasesRefresh() {
  const client = useQueryClient();
  return () => void client.invalidateQueries({ queryKey: keys.databases });
}

/** A table created, changed or deleted also changes what each guild and agent reaches. */
function useTablesRefresh() {
  const client = useQueryClient();
  return () => {
    void client.invalidateQueries({ queryKey: keys.databases });
    void client.invalidateQueries({ queryKey: keys.accessLists });
  };
}

export function useCreateDatabase() {
  const refresh = useTablesRefresh();
  return useMutation({
    mutationFn: (input: DatabaseInput) =>
      api<Collection>("/api/collections", { method: "POST", body: input }),
    onSuccess: refresh,
  });
}

/** Changes a database's name, purpose, columns or placement; its access list stays as it is. */
export function useUpdateDatabase(id: string) {
  const refresh = useTablesRefresh();
  return useMutation({
    mutationFn: (input: Partial<DatabaseInput>) =>
      api<Collection>(collectionPath(id), { method: "PATCH", body: input }),
    onSuccess: refresh,
  });
}

/** Deletes a database with its records; every guild and agent loses it at once. */
export function useDeleteDatabase() {
  const refresh = useTablesRefresh();
  return useMutation({
    mutationFn: (id: string) => api<undefined>(collectionPath(id), { method: "DELETE" }),
    onSuccess: refresh,
  });
}

/** Adds a record; with a unique column, a record holding the same value is merged into instead. */
export function useAddRecord(id: string) {
  const refresh = useDatabasesRefresh();
  return useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      api<{ record: CollectionRecord; merged: number | null }>(`${collectionPath(id)}/records`, {
        method: "POST",
        body: { body },
      }),
    onSuccess: refresh,
  });
}

/** Changes a record's values; null clears one. Warnings name values that still do not fit. */
export function useUpdateRecord(id: string) {
  const refresh = useDatabasesRefresh();
  return useMutation({
    mutationFn: ({ recordId, body }: { recordId: number; body: Record<string, unknown> }) =>
      api<{ record: CollectionRecord; warnings: string[] }>(
        `${collectionPath(id)}/records/${recordId}`,
        {
          method: "PATCH",
          body: { body },
        },
      ),
    onSuccess: refresh,
  });
}

export function useDeleteRecord(id: string) {
  const refresh = useDatabasesRefresh();
  return useMutation({
    mutationFn: (recordId: number) =>
      api<undefined>(`${collectionPath(id)}/records/${recordId}`, { method: "DELETE" }),
    onSuccess: refresh,
  });
}

/** Deletes every record; the database and its access list stay, and new ids carry on. */
export function useClearRecords(id: string) {
  const refresh = useDatabasesRefresh();
  return useMutation({
    mutationFn: () => api<undefined>(`${collectionPath(id)}/records`, { method: "DELETE" }),
    onSuccess: refresh,
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
    queryKey: keys.itemAccess(target),
    queryFn: () => api<AccessList>(itemAccessPath(target)),
  });
}

/** Studio's activity and State views in any session, which list access-list changes. */
const isStudioChangeView = (query: { queryKey: readonly unknown[] }) =>
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
      client.setQueryData(keys.itemAccess(target), list);
      void client.invalidateQueries({ queryKey: keys.accessLists });
      void client.invalidateQueries({ predicate: isStudioChangeView });
      // A Task embed resolves as its agent, so a changed list can mend or break one.
      void client.invalidateQueries({ queryKey: keys.embedStatuses });
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
    queryKey: keys.reach(subject),
    queryFn: () =>
      api<Reach>(`${reachPaths[subject.type]}/${encodeURIComponent(subject.id)}/reach`),
  });
}

/** Adds a user to the organisation by their @name; owners add owners, admins the rest. */
export function useAddMember(orgId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ name, role }: { name: string; role: OrgRole }) =>
      api<OrgMember>(`/api/orgs/${encodeURIComponent(orgId)}/members`, {
        method: "POST",
        body: { name, role },
      }),
    onSuccess: () => void client.invalidateQueries({ queryKey: keys.orgMembers(orgId) }),
  });
}

/** Every account on the box: the user directory, for the instance admin. */
export function useUsers() {
  return useQuery({ queryKey: keys.users, queryFn: () => api<User[]>("/api/users") });
}

/** A new account, with its personal organisation. */
export function useCreateUser() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: { name: string; email: string | null }) =>
      api<User>("/api/users", { method: "POST", body: input }),
    onSuccess: () => void client.invalidateQueries({ queryKey: keys.users }),
  });
}

/** Sets the email a user signs in with behind an authenticating proxy; null clears it. */
export function useSetUserEmail() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ userId, email }: { userId: string; email: string | null }) =>
      api<User>(`/api/users/${encodeURIComponent(userId)}`, { method: "PATCH", body: { email } }),
    onSuccess: () => void client.invalidateQueries({ queryKey: keys.users }),
  });
}

/** Changes a member's role; owners change owners, admins the rest. */
export function useUpdateMemberRole(orgId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ userId, role }: { userId: string; role: OrgRole }) =>
      api<OrgMember>(
        `/api/orgs/${encodeURIComponent(orgId)}/members/${encodeURIComponent(userId)}`,
        { method: "PATCH", body: { role } },
      ),
    onSuccess: () => void client.invalidateQueries({ queryKey: keys.orgMembers(orgId) }),
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
    onSuccess: () => void client.invalidateQueries({ queryKey: keys.orgMembers(orgId) }),
  });
}

/** Renames the organisation or changes its slug; owners and admins only. */
export function useUpdateOrg(orgId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: { name: string; slug: string }) =>
      api<Org>(`/api/orgs/${encodeURIComponent(orgId)}`, { method: "PATCH", body: input }),
    onSuccess: () => void client.invalidateQueries({ queryKey: keys.identity }),
  });
}

const orgModelsPath = (orgId: string) => `/api/orgs/${encodeURIComponent(orgId)}`;

/** The organisation's default, its providers, and the models it chose to offer: what every picker lists. */
export function useOrgModels(orgId: string) {
  return useQuery({
    queryKey: keys.orgModels(orgId),
    queryFn: () => api<OrgModels>(`${orgModelsPath(orgId)}/models`),
  });
}

/** A provider's whole catalog, or the local endpoint's live list; read by Model keys alone. */
export function useProviderCatalog(orgId: string, provider: ModelProvider, enabled: boolean) {
  return useQuery({
    queryKey: keys.providerCatalog(orgId, provider),
    queryFn: () =>
      api<{ models: CatalogModel[] }>(
        `${orgModelsPath(orgId)}/model-providers/${provider}/catalog`,
      ).then((body) => body.models),
    enabled,
    retry: false,
  });
}

function useOrgModelsWrite<T>(orgId: string, write: (input: T) => Promise<unknown>) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: write,
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: keys.orgModels(orgId) });
      void client.invalidateQueries({ queryKey: keys.capabilities });
    },
  });
}

/**
 * Connects a provider, or changes what it offers: the key (kept when left out on a connected
 * provider), the local endpoint's URL, and the chosen models. The key is probed before anything
 * is saved.
 */
export function useConnectModelProvider(orgId: string) {
  return useOrgModelsWrite(
    orgId,
    ({
      provider,
      ...body
    }: {
      provider: ModelProvider;
      api_key?: string;
      base_url?: string;
      models?: string[];
    }) =>
      api<OrgModelProvider>(`${orgModelsPath(orgId)}/model-providers/${provider}`, {
        method: "PUT",
        body,
      }),
  );
}

/** Names the organisation's default model, or clears it with null. */
export function useSetDefaultModel(orgId: string) {
  return useOrgModelsWrite(orgId, (model: string | null) =>
    api<{ default: string | null }>(`${orgModelsPath(orgId)}/default-model`, {
      method: "PUT",
      body: { model },
    }),
  );
}

/** Removes a provider's key and its chosen models; a default among them clears. */
export function useRemoveModelProvider(orgId: string) {
  return useOrgModelsWrite(orgId, (provider: ModelProvider) =>
    api<undefined>(`${orgModelsPath(orgId)}/model-providers/${provider}`, { method: "DELETE" }),
  );
}

/**
 * The signed-in operator's own settings: their name, the timezone new random-window routines start
 * from, and the identity colour their messages and avatar take. A field left out keeps its value.
 */
export function useUpdateProfile() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (profile: { name?: string; timezone?: string | null; color?: string | null }) =>
      api<User>("/api/auth/me", { method: "PATCH", body: profile }),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: keys.identity });
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
    queryKey: keys.orgUsage,
    queryFn: () => api<{ organisation: OrgUsage }>("/api/usage"),
    select: (data) => data.organisation,
  });
}

export function useAdminCatalog() {
  return useQuery({
    queryKey: keys.adminCatalog,
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
    mutationFn: ({ id, input }: { id?: string; input: CatalogServerInput }) =>
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
    mutationFn: ({
      serverId,
      name,
      input,
    }: {
      serverId: string;
      name: string;
      input: CatalogToolInput;
    }) =>
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
    queryKey: keys.adminRegistry,
    queryFn: () => api<RegistryConnectors>("/api/admin/registry"),
    retry: false,
  });
}

const registryConnectorPath = (slug: string) =>
  `/api/admin/registry/connectors/${encodeURIComponent(slug)}`;

/** What installing or updating a registry connector accepts: an unverified or experimental one. */
type RegistryAcceptance = { unverified: boolean; experimental?: boolean };

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
    mutationFn: ({ slug, ...accepted }: { slug: string } & RegistryAcceptance) =>
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
    mutationFn: ({ slug, ...accepted }: { slug: string } & RegistryAcceptance) =>
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

/** The organisation's recipes, newest first. */
export function useRecipes() {
  return useQuery({ queryKey: keys.recipes, queryFn: () => api<RecipeRow[]>("/api/recipes") });
}

/** Imports a recipe file as a draft; secrets and tokens in it are refused. */
export function useImportRecipe() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (recipe: unknown) =>
      api<RecipeRow>("/api/recipes/import", { method: "POST", body: { recipe } }),
    onSuccess: () => void client.invalidateQueries({ queryKey: keys.recipes }),
  });
}

/** The recipes the registry offers. */
export function useRecipeRegistry() {
  return useQuery({
    queryKey: keys.recipeRegistry,
    queryFn: () => api<RegistryRecipes>("/api/recipes/registry"),
    retry: false,
  });
}

/** Imports a registry recipe as a draft: its newest version unless `version` names one. */
export function useImportRegistryRecipe() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: { name: string; version?: string }) =>
      api<RecipeRow>("/api/recipes/registry/import", { method: "POST", body: input }),
    onSuccess: () => void client.invalidateQueries({ queryKey: keys.recipes }),
  });
}

/** Captures a live guild as a draft recipe: its roles, prompts, tools, routines and scripts. */
export function useCaptureRecipe() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (guildId: string) =>
      api<RecipeRow>(`${guildPath(guildId)}/recipes`, { method: "POST", body: {} }),
    onSuccess: () => void client.invalidateQueries({ queryKey: keys.recipes }),
  });
}

const studioPath = (id: string) => `/api/studio/sessions/${encodeURIComponent(id)}`;

/** The operator's Studio sessions, newest first. */
export function useStudioSessions() {
  return useQuery({
    queryKey: keys.studioSessions,
    queryFn: () => api<StudioSession[]>("/api/studio/sessions"),
  });
}

export function useStudioSession(id: string) {
  return useQuery({
    queryKey: keys.studio(id),
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
    mutationFn: async ({ content, focus }: { content: string; focus: unknown }) => {
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
    onSuccess: () => void client.invalidateQueries({ queryKey: keys.studioSessions }),
  });
}

/** Starts a coach session on a guild; `parent` continues an earlier one. */
export function useCreateStudioSession() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: { guildId: string; model: string; temperature: number; parent?: string }) =>
      api<StudioSession>("/api/studio/sessions", {
        method: "POST",
        body: {
          mode: "optimize",
          source_guild_id: input.guildId,
          coach_config: { model: input.model, temperature: input.temperature },
          ...(input.parent ? { parent_session_id: input.parent } : {}),
        },
      }),
    onSuccess: () => void client.invalidateQueries({ queryKey: keys.studioSessions }),
  });
}

export function useStudioMessages(id: string, generating: boolean) {
  return useQuery({
    queryKey: keys.studioMessages(id),
    queryFn: () => api<StudioMessage[]>(`${studioPath(id)}/messages`),
    refetchInterval: generating ? generatingPollMs : false,
  });
}

function useStudioRefresh(id: string) {
  const client = useQueryClient();
  return () => void client.invalidateQueries({ queryKey: keys.studio(id) });
}

/** Sends the operator's message, pinned to what `focus` names when given. */
export function usePostStudioMessage(id: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: { content: string; focus?: unknown }) =>
      api<StudioSession>(`${studioPath(id)}/messages`, { method: "POST", body: input }),
    onMutate: async () => {
      await client.cancelQueries({ queryKey: keys.studio(id) });
      const previous = client.getQueryData<StudioSession>(keys.studio(id));
      if (previous) {
        client.setQueryData(keys.studio(id), { ...previous, generation_state: "generating" });
      }
      return { previous };
    },
    onError: (_error, _input, context) => {
      if (context?.previous) client.setQueryData(keys.studio(id), context.previous);
    },
    onSuccess: (session) => {
      client.setQueryData(keys.studio(id), session);
      void client.invalidateQueries({ queryKey: keys.studioMessages(id) });
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
    onSuccess: () => void client.invalidateQueries({ queryKey: keys.studioSessions }),
  });
}

export function useStudioInventory(id: string, enabled: boolean) {
  return useQuery({
    queryKey: keys.studioInventory(id),
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
    queryKey: keys.studioInspector(id, agentId ?? ""),
    queryFn: () =>
      api<StudioInspector>(`${studioPath(id)}/agents/${encodeURIComponent(agentId ?? "")}`),
    enabled: Boolean(agentId),
  });
}

export function useStudioDrafts(id: string) {
  return useQuery({
    queryKey: keys.studioDrafts(id),
    queryFn: () => api<StudioDraft[]>(`${studioPath(id)}/drafts`),
  });
}

const draftPath = (id: string) => `/api/studio/drafts/${encodeURIComponent(id)}`;

/** Publishes a draft as the agent's new Task; one written over a changed Task becomes conflicted. */
export function useDraftAction(sessionId: string) {
  const refresh = useStudioRefresh(sessionId);
  return useMutation({
    mutationFn: ({
      draftId,
      action,
      content,
    }: {
      draftId: string;
      action: "publish" | "discard" | "revise";
      content?: string;
    }) =>
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
      queryKey: keys.studioEdit(id, seq),
      queryFn: () => api<StudioEdit>(`${studioPath(id)}/edits/${seq}`),
    })),
  });
}

/** Applies or declines one coach edit; an applied table edit refreshes the databases too. */
export function useDecideEdit(id: string) {
  const client = useQueryClient();
  const refresh = useStudioRefresh(id);
  return useMutation({
    mutationFn: ({ seq, decision }: { seq: number; decision: "apply" | "decline" }) =>
      api(`${studioPath(id)}/edits/${seq}`, { method: "POST", body: { decision } }),
    onSuccess: () => {
      refresh();
      void client.invalidateQueries({ queryKey: keys.databases });
      void client.invalidateQueries({ queryKey: keys.accessAll });
    },
  });
}

export function useStudioConnections(id: string) {
  return useQuery({
    queryKey: keys.studioConnections(id),
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
    mutationFn: ({ seq, decision }: { seq: number; decision: "grant" | "decline" }) =>
      api<StudioSession>(`${studioPath(id)}/logins/${seq}`, { method: "POST", body: { decision } }),
    onSuccess: refresh,
  });
}

export function useGrantStudioConnection(id: string) {
  const refresh = useStudioRefresh(id);
  return useMutation({
    mutationFn: ({ connectionId, granted }: { connectionId: string; granted: boolean }) =>
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
    queryKey: keys.studioRuns(id, agentId),
    queryFn: () =>
      api<StudioRun[]>(`${studioPath(id)}/agents/${encodeURIComponent(agentId)}/runs?limit=200`),
    refetchInterval: (query) =>
      query.state.data?.some((run) => run.generating) ? studioPollMs : false,
  });
}

export function useStudioRoutines(id: string, agentId: string) {
  return useQuery({
    queryKey: keys.studioRoutines(id, agentId),
    queryFn: () =>
      api<StudioRoutine[]>(`${studioPath(id)}/agents/${encodeURIComponent(agentId)}/routines`),
  });
}

/** Every version of an agent's memory, newest first, with who wrote it. */
export function useMemoryTimeline(id: string, agentId: string) {
  return useQuery({
    queryKey: keys.studioMemory(id, agentId),
    queryFn: () =>
      api<MemoryTimeline>(
        `${studioPath(id)}/agents/${encodeURIComponent(agentId)}/memory-timeline`,
      ),
  });
}

/** The guild's wakes over the last `hours`; re-read while one is running. */
export function useStudioActivity(id: string, hours: number) {
  return useQuery({
    queryKey: keys.studioActivity(id, hours),
    queryFn: () => api<ActivityView>(`${studioPath(id)}/activity?hours=${hours}`),
    placeholderData: keepPreviousData,
    refetchInterval: (query) =>
      query.state.data?.wakes.some((wake) => wake.running) ? studioPollMs : false,
  });
}

/** The guild's notes, tables, scripts and Memory with their changes and reads in the window. */
export function useStudioState(
  id: string,
  filter: { hours: number; agent: string | null; kind: string | null },
) {
  const query: Record<string, string> = {
    hours: String(filter.hours),
    ...(filter.agent ? { agent: filter.agent } : {}),
    ...(filter.kind ? { kind: filter.kind } : {}),
  };
  return useQuery({
    queryKey: keys.studioState(id, query),
    queryFn: () =>
      api<{ items: StateItemRow[] }>(`${studioPath(id)}/state?${new URLSearchParams(query)}`).then(
        (body) => body.items,
      ),
    placeholderData: keepPreviousData,
  });
}

/** One State item: who changes and reads it, and its history a page at a time. */
export function useStudioStateItem(id: string, item: { path: string; hours: number; op: string | null }) {
  return useInfiniteQuery({
    queryKey: keys.studioStateItem(id, item.path, item.hours, item.op ?? ""),
    queryFn: ({ pageParam }) => {
      const query = new URLSearchParams({ path: item.path, hours: String(item.hours) });
      if (item.op) query.set("op", item.op);
      if (pageParam) query.set("cursor", pageParam);
      return api<StateItemDetail>(`${studioPath(id)}/state/item?${query}`);
    },
    initialPageParam: null as string | null,
    getNextPageParam: (page) => page.next_cursor,
  });
}

/** Every tool the guild's agents are offered or called in the window. */
export function useStudioTools(id: string, hours: number) {
  return useQuery({
    queryKey: keys.studioTools(id, hours),
    queryFn: () =>
      api<{ tools: StudioTool[] }>(`${studioPath(id)}/tools?hours=${hours}`).then((body) => body.tools),
    placeholderData: keepPreviousData,
  });
}

/** One tool's calls in the window, newest first, a page at a time. */
export function useStudioToolCalls(
  id: string,
  tool: { name: string; hours: number; errorsOnly: boolean },
) {
  return useInfiniteQuery({
    queryKey: keys.studioToolCalls(id, tool.name, tool.hours, tool.errorsOnly),
    queryFn: ({ pageParam }) => {
      const query = new URLSearchParams({ hours: String(tool.hours) });
      if (tool.errorsOnly) query.set("errors", "true");
      if (pageParam) query.set("cursor", pageParam);
      return api<{ calls: StudioToolCall[]; next_cursor: string | null }>(
        `${studioPath(id)}/tools/${encodeURIComponent(tool.name)}/calls?${query}`,
      );
    },
    initialPageParam: null as string | null,
    getNextPageParam: (page) => page.next_cursor,
  });
}

/** What each Task and file in the session's guild embeds or names; re-read when files change. */
export function useStudioReferences(id: string) {
  return useQuery({
    queryKey: keys.studioReferences(id),
    queryFn: () => api<StudioReferences>(`${studioPath(id)}/references`),
  });
}

const recipePath = (id: string) => `/api/recipes/${encodeURIComponent(id)}`;

export function useRecipe(id: string) {
  return useQuery({ queryKey: keys.recipe(id), queryFn: () => api<RecipeRow>(recipePath(id)) });
}

/** The recipe's findings against the organisation as it is now, for one version of its body. */
export function useRecipeValidation(id: string, version: number | undefined) {
  return useQuery({
    queryKey: keys.recipeValidation(id, version ?? -1),
    queryFn: () =>
      api<RecipeValidation>(`${recipePath(id)}/validate`, { method: "POST", body: {} }),
    enabled: version !== undefined,
  });
}

/** The connector catalog, models and plan room the recipe pages and the Builder read. */
export function useCapabilities() {
  return useQuery({
    queryKey: keys.capabilities,
    queryFn: () => api<BuilderCapabilities>("/api/builder/capabilities"),
    staleTime: 60_000,
  });
}

function useRecipeWrite<T>(id: string, write: (input: T) => Promise<RecipeRow>) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: write,
    onSuccess: (row) => {
      client.setQueryData(keys.recipe(id), row);
      void client.invalidateQueries({ queryKey: keys.recipes });
    },
  });
}

/** Approves the recipe once nothing blocks it; any later edit returns it to draft. */
export function usePublishRecipe(id: string) {
  return useRecipeWrite(id, () => api<RecipeRow>(`${recipePath(id)}/publish`, { method: "POST" }));
}

/** Renames or redescribes the recipe, refused (409) over a newer body. */
export function useUpdateRecipe(id: string) {
  return useRecipeWrite(
    id,
    (input: { name: string; description: string; expected_body_version: number }) =>
      api<RecipeRow>(recipePath(id), { method: "PUT", body: input }),
  );
}

/** Switches tools per role and removes connectors, returning the recipe with every cut. */
export function useRecipeAccess(id: string) {
  return useRecipeWrite(id, (edits: AccessEdit[]) =>
    api<AccessEditResult>(`${recipePath(id)}/access`, { method: "POST", body: { edits } }),
  );
}

/** Confirms a field the Builder wrote, or replaces it with the operator's text. */
export function useReviewRecipe(id: string) {
  return useRecipeWrite(id, (input: { path: string; action: "confirm" | "edit"; value?: string }) =>
    api<RecipeRow>(`${recipePath(id)}/review`, { method: "POST", body: input }),
  );
}

export function useDeleteRecipe() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api(recipePath(id), { method: "DELETE" }),
    onSuccess: () => void client.invalidateQueries({ queryKey: keys.recipes }),
  });
}

/** The approved recipe as a portable file; refused (409) while it is a draft. */
export function exportRecipe(id: string) {
  return api<RecipeDocument>(`${recipePath(id)}/export`);
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

/**
 * What applying the recipe would create now, with its findings: live logins to reuse, name
 * collisions, tables that already exist, and the machine the roles go on (the one named, or the
 * organisation's only one). Nothing is written.
 */
export function useRecipePreview(id: string, version: number | undefined, machineId?: string) {
  return useQuery({
    queryKey: [...keys.recipePreview(id, version ?? -1), machineId ?? ""],
    queryFn: () =>
      api<ApplyPreview>(`${recipePath(id)}/preview`, {
        method: "POST",
        body: {
          connections: [],
          names: [],
          models: [],
          ...(machineId ? { machine_id: machineId } : {}),
        },
      }),
    enabled: version !== undefined,
    placeholderData: keepPreviousData,
    retry: false,
  });
}

/** Creates the guild from an approved recipe, its routines paused, and returns its checklist. */
export function useApplyRecipe(id: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (choices: ApplyChoices) =>
      api<ApplyRow>(`${recipePath(id)}/apply`, { method: "POST", body: choices }),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: keys.guilds });
      refreshMachines(client);
    },
  });
}

const applyPath = (id: string) => `/api/applies/${encodeURIComponent(id)}`;

export function useApply(id: string) {
  return useQuery({ queryKey: keys.apply(id), queryFn: () => api<ApplyRow>(applyPath(id)) });
}

function fetchGuildApply(guildId: string) {
  return api<GuildApplyState>(`${guildPath(guildId)}/apply`);
}

/** The guild's apply while its checklist is open; null once it is done or aborted. */
export function useGuildApply(guildId: string) {
  return useQuery({
    queryKey: keys.guildApply(guildId),
    queryFn: () => fetchGuildApply(guildId),
    select: (body) => body.apply,
  });
}

/** Agents a ready recipe apply still asks to log in by hand. Empty while the checklist is open. */
export function useGuildBrowserLogins(guildId: string) {
  return useQuery({
    queryKey: keys.guildApply(guildId),
    queryFn: () => fetchGuildApply(guildId),
    select: (body) => body.browser_logins ?? [],
  });
}

function useApplyWrite<T>(id: string, write: (input: T) => Promise<ApplyRow>) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: write,
    onSuccess: (row) => {
      client.setQueryData(keys.apply(id), row);
      void client.invalidateQueries({ queryKey: ["guilds"] });
    },
  });
}

/** Checks a login or secret step against the guild as it is now. */
export function useVerifyStep(id: string) {
  return useApplyWrite(id, (stepId: string) =>
    api<ApplyRow>(`${applyPath(id)}/steps/${encodeURIComponent(stepId)}/verify`, {
      method: "POST",
    }),
  );
}

/** Confirms a step done by hand, or skips a login or secret the guild will do without. */
export function useConfirmStep(id: string) {
  return useApplyWrite(id, ({ stepId, skip }: { stepId: string; skip?: boolean }) =>
    api<ApplyRow>(`${applyPath(id)}/steps/${encodeURIComponent(stepId)}/confirm`, {
      method: "POST",
      body: skip ? { skip: true } : {},
    }),
  );
}

/** Starts the paused routines once every required step is closed. */
export function useActivateApply(id: string) {
  return useApplyWrite(id, () => api<ApplyRow>(`${applyPath(id)}/activate`, { method: "POST" }));
}

/** Stops the apply, deleting the guild it created with its agents and tables. */
export function useAbortApply(id: string) {
  return useApplyWrite(id, () => api<ApplyRow>(`${applyPath(id)}/abort`, { method: "POST" }));
}

const builderPath = (id: string) => `/api/builder/sessions/${encodeURIComponent(id)}`;

/** The operator's own Builder sessions, most recently active first. */
export function useBuilderSessions() {
  return useQuery({
    queryKey: keys.builderSessions,
    queryFn: () => api<BuilderSessionSummary[]>("/api/builder/sessions"),
  });
}

/**
 * Starts a Builder session on an empty draft recipe and sends the operator's description as its
 * first message. The session exists even when that message fails, so the error comes back with it.
 */
export function useStartBuilder() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async ({ model, brief }: { model: string; brief: string }) => {
      const session = await api<BuilderSession>("/api/builder/sessions", {
        method: "POST",
        body: { model },
      });
      try {
        await api(`${builderPath(session.id)}/messages`, {
          method: "POST",
          body: { content: brief },
        });
        return { session, error: null };
      } catch (error) {
        return { session, error: error instanceof Error ? error : new Error(String(error)) };
      }
    },
    onSuccess: () => void client.invalidateQueries({ queryKey: keys.builderSessions }),
  });
}

/** While the coach works, the session and its conversation are re-read every few seconds, in case the stream falls silent. */
export function useBuilderSession(id: string) {
  return useQuery({
    queryKey: keys.builder(id),
    queryFn: () => api<BuilderSession>(builderPath(id)),
    refetchInterval: (query) =>
      query.state.data && query.state.data.generation_state !== "idle" ? generatingPollMs : false,
  });
}

export function useBuilderMessages(id: string, generating: boolean) {
  return useQuery({
    queryKey: keys.builderMessages(id),
    queryFn: () => api<StudioMessage[]>(`${builderPath(id)}/messages`),
    refetchInterval: generating ? generatingPollMs : false,
  });
}

function useBuilderRefresh(id: string) {
  const client = useQueryClient();
  return () => {
    void client.invalidateQueries({ queryKey: keys.builder(id) });
    void client.invalidateQueries({ queryKey: keys.recipes });
  };
}

export function usePostBuilderMessage(id: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (content: string) =>
      api<BuilderSession>(`${builderPath(id)}/messages`, { method: "POST", body: { content } }),
    onMutate: async () => {
      await client.cancelQueries({ queryKey: keys.builder(id) });
      const previous = client.getQueryData<BuilderSession>(keys.builder(id));
      if (previous) {
        client.setQueryData(keys.builder(id), { ...previous, generation_state: "generating" });
      }
      return { previous };
    },
    onError: (_error, _content, context) => {
      if (context?.previous) client.setQueryData(keys.builder(id), context.previous);
    },
    onSuccess: (session) => {
      client.setQueryData(keys.builder(id), session);
      void client.invalidateQueries({ queryKey: keys.builderMessages(id) });
    },
  });
}

export function useCancelBuilder(id: string) {
  const refresh = useBuilderRefresh(id);
  return useMutation({
    mutationFn: () => api(`${builderPath(id)}/cancel`, { method: "POST" }),
    onSettled: refresh,
  });
}

/** The draft's findings, for the version of its body the session holds. */
export function useBuilderValidation(id: string, version: number | undefined, enabled: boolean) {
  return useQuery({
    queryKey: keys.builderValidation(id, version ?? -1),
    queryFn: () =>
      api<RecipeValidation>(`${builderPath(id)}/validate`, { method: "POST", body: {} }),
    enabled: enabled && version !== undefined,
  });
}

/** Confirms a field the coach wrote, or replaces it with the operator's text. */
export function useBuilderReview(id: string) {
  const refresh = useBuilderRefresh(id);
  return useMutation({
    mutationFn: (input: { path: string; action: "confirm" | "edit"; value?: string }) =>
      api<RecipeRow>(`${builderPath(id)}/review`, { method: "POST", body: input }),
    onSuccess: refresh,
  });
}

/** Switches connector tools per role and removes connectors in the draft. */
export function useBuilderAccess(id: string) {
  const refresh = useBuilderRefresh(id);
  return useMutation({
    mutationFn: (edits: AccessEdit[]) =>
      api<AccessEditResult>(`${builderPath(id)}/access`, { method: "POST", body: { edits } }),
    onSuccess: refresh,
  });
}

/** Approves the draft once nothing blocks it; the next write by the coach returns it to draft. */
export function usePublishBuilder(id: string) {
  const refresh = useBuilderRefresh(id);
  return useMutation({
    mutationFn: () => api<RecipeRow>(`${builderPath(id)}/publish`, { method: "POST" }),
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
