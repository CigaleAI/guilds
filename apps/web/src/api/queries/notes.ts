import {
  useMutation,
  useQueries,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { api } from "../client";
import { guildPath } from "./guilds";
import type { AccessSubject } from "../types/access";
import type {
  EmbeddableNote,
  EmbeddedNote,
  EmbedStatus,
  FileContent,
  NoteItem,
  FileChange,
  TaskFile,
  MemoryTimeline,
  TaskInput,
  NoteInput,
} from "../types/notes";

/**
 * Query keys of notes, Tasks, memory and their embeds. Identity is fixed for the page's life, so
 * keys carry no user or org.
 */
export const noteKeys = {
  /** Everything read from notes, memory, Tasks and tables; a file change in any guild refreshes it. */
  artifacts: ["artifacts"] as const,
  agentTask: (agentId: string) => ["artifacts", "task", agentId] as const,
  agentMemory: (agentId: string) => ["artifacts", "memory", agentId] as const,
  embeddableNotes: ["artifacts", "embeddable-notes"] as const,
  embedStatuses: ["artifacts", "embed-status"] as const,
  embedStatus: (guildId: string) => ["artifacts", "embed-status", guildId] as const,
  latestChange: (displayPath: string) => ["artifacts", "latest-change", displayPath] as const,
  fileChanges: (displayPath: string) => ["artifacts", "changes", displayPath] as const,
  liveMemory: (agentId: string) => ["artifacts", "live-memory", agentId] as const,
  noteLists: ["artifacts", "notes"] as const,
  noteList: (page: AccessSubject) => ["artifacts", "notes", page.type, page.id] as const,
  note: (key: string) => ["artifacts", "note", key] as const,
};

/** Each listed guild's agents whose Task embeds something the agent cannot reach, by agent. */
export function useBrokenEmbeds(guildIds: readonly string[]) {
  return useQueries({
    queries: guildIds.map((guildId) => ({
      queryKey: noteKeys.embedStatus(guildId),
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

/** Where the agent's `task.md` or `memory.md` is read and written. */
function agentFilePath(agentId: string, name: "task.md" | "memory.md"): string {
  return `/api/agents/${encodeURIComponent(agentId)}/notes/${name}`;
}

const taskPath = (agentId: string) => agentFilePath(agentId, "task.md");

export function useAgentTask(agentId: string) {
  return useQuery({
    queryKey: noteKeys.agentTask(agentId),
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
    mutationFn: (body: TaskInput) =>
      api<TaskFile>(taskPath(agentId), { method: "PUT", body }),
    onSuccess: (task) => {
      client.setQueryData(noteKeys.agentTask(agentId), task);
      void client.invalidateQueries({ queryKey: noteKeys.embedStatus(guildId) });
      if (task.display_path)
        void client.invalidateQueries({ queryKey: noteKeys.latestChange(task.display_path) });
    },
  });
}

/** Every version of the agent's memory, newest first; the live one has no revision id. */
export function useAgentMemory(agentId: string) {
  return useQuery({
    queryKey: noteKeys.agentMemory(agentId),
    queryFn: () => api<MemoryTimeline>(`/api/agents/${encodeURIComponent(agentId)}/memory`),
  });
}

/** The agent's live memory, as its `memory.md`. */
export function useLiveMemory(agentId: string) {
  return useQuery({
    queryKey: noteKeys.liveMemory(agentId),
    queryFn: () => api<FileContent>(agentFilePath(agentId, "memory.md")),
  });
}

/**
 * Writes the agent's live memory, read with `useLiveMemory`. The server archives the text it
 * replaces, which becomes the previous version.
 */
export function useSaveMemory(agentId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (content: string) =>
      api<FileContent>(agentFilePath(agentId, "memory.md"), { method: "PUT", body: { content } }),
    onSuccess: (file) => {
      client.setQueryData(noteKeys.liveMemory(agentId), file);
      void client.invalidateQueries({ queryKey: noteKeys.agentMemory(agentId) });
      void client.invalidateQueries({ queryKey: noteKeys.latestChange(file.display_path) });
    },
  });
}

/** Notes the operator can read and embed, across the organisation (the server lists up to 500). */
export function useEmbeddableNotes() {
  return useQuery({
    queryKey: noteKeys.embeddableNotes,
    queryFn: () => api<EmbeddableNote[]>("/api/org/embeddable-notes"),
  });
}

/** One note by display path, for a note the list did not include; 404 when it no longer resolves. */
export function useEmbeddableNote(displayPath: string | null, enabled: boolean) {
  return useQuery({
    queryKey: [...noteKeys.embeddableNotes, displayPath ?? ""],
    queryFn: () =>
      api<EmbeddedNote>(
        `/api/org/embeddable-notes?display_path=${encodeURIComponent(displayPath ?? "")}`,
      ),
    enabled: Boolean(displayPath) && enabled,
  });
}

export function useEmbedStatus(guildId: string) {
  return useQuery({
    queryKey: noteKeys.embedStatus(guildId),
    queryFn: () => api<EmbedStatus>(`/api/guilds/${encodeURIComponent(guildId)}/embed-status`),
  });
}

/** The newest recorded change to a file, or null when none is recorded. */
export function useLatestChange(displayPath: string | undefined) {
  return useQuery({
    queryKey: noteKeys.latestChange(displayPath ?? ""),
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
    queryKey: noteKeys.fileChanges(displayPath ?? ""),
    queryFn: () =>
      api<FileChange[]>(`/api/file-changes?display_path=${encodeURIComponent(displayPath ?? "")}`),
    enabled: Boolean(displayPath),
  });
}

/**
 * The route that lists a page's notes: the organisation's lists every note, a guild's the notes
 * whose access list names the guild, one of its agents or the organisation, an agent's the notes
 * it reads.
 */
function noteListPath(page: AccessSubject): string {
  if (page.type === "org") return "/api/org/notes";
  return `/api/${page.type === "guild" ? "guilds" : "agents"}/${encodeURIComponent(page.id)}/notes`;
}

/** Where the organisation's note with this key is read, written and deleted. */
function notePath(key: string): string {
  return `/api/org/notes/${encodeURIComponent(key)}`;
}

/** The notes a page lists, or nothing when there is no page. */
export function useNoteList(page: AccessSubject | null) {
  return useQuery({
    queryKey: page ? noteKeys.noteList(page) : noteKeys.noteLists,
    queryFn: () => api<NoteItem[]>(page ? noteListPath(page) : ""),
    enabled: Boolean(page),
  });
}

/** The organisation's note with this key. */
export function useNote(key: string | null) {
  return useQuery({
    queryKey: noteKeys.note(key ?? ""),
    queryFn: () => api<FileContent>(notePath(key ?? "")),
    enabled: Boolean(key),
  });
}

/**
 * Writes the organisation's note at a key, creating it with the input's first access row when no
 * note has that key. Notes are last-writer-wins: a save replaces whatever is there.
 */
export function useSaveNote() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ path, content, access }: NoteInput) =>
      api<FileContent>(notePath(path), { method: "PUT", body: { content, ...(access ? { access } : {}) } }),
    onSuccess: (file, { path }) => {
      client.setQueryData(noteKeys.note(path), file);
      void client.invalidateQueries({ queryKey: noteKeys.noteLists });
      void client.invalidateQueries({ queryKey: noteKeys.embeddableNotes });
      void client.invalidateQueries({ queryKey: noteKeys.latestChange(file.display_path) });
    },
  });
}

/** Deletes the organisation's note with this key; the server refuses one a Task still embeds. */
export function useDeleteNote() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (key: string) => api<undefined>(notePath(key), { method: "DELETE" }),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: noteKeys.noteLists });
      void client.invalidateQueries({ queryKey: noteKeys.embeddableNotes });
    },
  });
}
