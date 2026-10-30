import {
  useMutation,
  useQueries,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { api } from "../client";
import { guildPath } from "./guilds";
import type {
  EmbeddableNote,
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
  noteList: (prefix: string) => ["artifacts", "notes", prefix] as const,
  note: (prefix: string, path: string) => ["artifacts", "note", prefix, path] as const,
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

/** The agent's notes scope; its live memory and its Task are read and written by name inside it. */
export const agentNotesPrefix = (agentId: string): NotesPrefix =>
  `/api/agents/${encodeURIComponent(agentId)}/notes`;

const taskPath = (agentId: string) => `${agentNotesPrefix(agentId)}/task.md`;

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
      client.setQueryData(noteKeys.note(prefix, "memory.md"), file);
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
      api<Pick<EmbeddableNote, "display_path" | "title" | "level" | "content">>(
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

/** A notes scope's API root: `/api/agents/notes`, `/api/guilds/notes` or `/api/org/notes`. */
export type NotesPrefix = string;

function filePath(prefix: NotesPrefix, path: string): string {
  return `${prefix}/${path.split("/").map(encodeURIComponent).join("/")}`;
}

/** A scope's notes, or nothing when there is no scope. */
export function useNoteList(prefix: NotesPrefix | null) {
  return useQuery({
    queryKey: noteKeys.noteList(prefix ?? ""),
    queryFn: () => api<NoteItem[]>(prefix ?? ""),
    enabled: Boolean(prefix),
  });
}

export function useNote(prefix: NotesPrefix, path: string | null) {
  return useQuery({
    queryKey: noteKeys.note(prefix, path ?? ""),
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
    mutationFn: ({ path, content }: NoteInput) =>
      api<FileContent>(filePath(prefix, path), { method: "PUT", body: { content } }),
    onSuccess: (file, { path }) => {
      client.setQueryData(noteKeys.note(prefix, path), file);
      void client.invalidateQueries({ queryKey: noteKeys.noteList(prefix) });
      void client.invalidateQueries({ queryKey: noteKeys.embeddableNotes });
      void client.invalidateQueries({ queryKey: noteKeys.latestChange(file.display_path) });
    },
  });
}

/** Deletes a note; the server refuses one a Task still embeds. */
export function useDeleteNote(prefix: NotesPrefix) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (path: string) => api<undefined>(filePath(prefix, path), { method: "DELETE" }),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: noteKeys.noteList(prefix) });
      void client.invalidateQueries({ queryKey: noteKeys.embeddableNotes });
    },
  });
}
