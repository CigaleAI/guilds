import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { applyLiveDelta, type LiveTurn } from "./liveTurn";
import { agentKeys } from "./queries/agents";
import { builderKeys } from "./queries/builder";
import { chatKeys, showClearedGroupChat } from "./queries/chat";
import { guildKeys } from "./queries/guilds";
import { issueKeys } from "./queries/issues";
import { noteKeys } from "./queries/notes";
import { recipeKeys } from "./queries/recipes";
import { runKeys } from "./queries/runs";
import { scheduleKeys } from "./queries/schedules";
import { scriptKeys } from "./queries/scripts";
import { studioKeys } from "./queries/studio";
import { tableKeys } from "./queries/tables";
import { applyToolProgress, dropToolProgress, type ToolProgress } from "./toolProgress";
import type { GroupChatState, GroupMessage, MessageNotice } from "./types/chat";
import type { Run, RunMessage } from "./types/runs";
import type { StudioMessage, StudioSession } from "./types/studio";
import type { BuilderSession } from "./types/builder";

type StreamOptions = {
  /** Event names to listen for. */
  events: readonly string[];
  onEvent: (name: string, data: unknown) => void;
  /** Runs on every (re)connection. The server replays nothing, so this is where to catch up. */
  onOpen?: () => void;
  /** Delay before reconnecting after the stream drops. */
  retryMs?: number;
};

/** An SSE stream held open while the component is mounted, reconnecting after it drops. */
export function useEventStream(url: string | null, options: StreamOptions): void {
  const latest = useRef(options);
  useEffect(() => {
    latest.current = options;
  });
  const eventList = options.events.join(",");
  const retryMs = options.retryMs ?? 1000;

  useEffect(() => {
    if (!url) return;
    let source: EventSource | null = null;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let closed = false;

    const connect = () => {
      source = new EventSource(url, { withCredentials: true });
      source.onopen = () => latest.current.onOpen?.();
      for (const name of eventList.split(",")) {
        source.addEventListener(name, (event) => {
          let data: unknown = null;
          try {
            data = JSON.parse((event as MessageEvent<string>).data);
          } catch {
            // A malformed frame carries nothing to apply.
          }
          latest.current.onEvent(name, data);
        });
      }
      source.onerror = () => {
        source?.close();
        if (!closed) retry = setTimeout(connect, retryMs);
      };
    };
    connect();

    return () => {
      closed = true;
      clearTimeout(retry);
      source?.close();
    };
  }, [url, eventList, retryMs]);
}

const guildEvents = [
  "group.message.committed",
  "group.cleared",
  "group.limit_reached",
  "group.idle",
  "group.delivery.started",
  "group.delivery.finished",
  "group.delivery.failed",
  "guild.issues.changed",
  "guild.artifacts.changed",
  "agent.routines.changed",
  "agent.scripts.changed",
] as const;

/**
 * Keeps a guild's chat, agents, open issues, files and routines current: committed messages are
 * added to the cached history, a cleared chat empties it, chat state changes re-read the state and who is generating, a file
 * change refreshes every file read, and a routine or script change refreshes that agent's.
 */
export function useGuildStream(guildId: string): void {
  const client = useQueryClient();
  useEventStream(`/api/guilds/${encodeURIComponent(guildId)}/group-chat/stream`, {
    events: guildEvents,
    onOpen: () => {
      void client.invalidateQueries({ queryKey: chatKeys.chatMessages(guildId) });
      void client.invalidateQueries({ queryKey: chatKeys.chatState(guildId) });
      void client.invalidateQueries({ queryKey: agentKeys.agents(guildId) });
    },
    onEvent: (name, data) => {
      if (name === "group.message.committed") {
        const message = data as GroupMessage;
        client.setQueryData<GroupMessage[]>(chatKeys.chatMessages(guildId), (messages) =>
          messages && !messages.some((known) => known.seq === message.seq)
            ? [...messages, message].sort((a, b) => a.seq - b.seq)
            : messages,
        );
        void client.invalidateQueries({ queryKey: chatKeys.chatState(guildId) });
        return;
      }
      if (name === "group.cleared") {
        showClearedGroupChat(client, guildId, data as GroupChatState);
        return;
      }
      if (name === "group.idle" || name === "group.limit_reached") {
        const state = data as GroupChatState;
        client.setQueryData<GroupChatState>(chatKeys.chatState(guildId), (previous) => ({
          ...state,
          seen_through_seq: previous?.seen_through_seq ?? null,
        }));
      } else if (name === "guild.issues.changed") {
        void client.invalidateQueries({ queryKey: issueKeys.issues(guildId) });
        return;
      } else if (name === "guild.artifacts.changed") {
        void client.invalidateQueries({ queryKey: noteKeys.artifacts });
        return;
      } else if (name === "agent.scripts.changed") {
        const agentId = (data as { agent_id?: string } | null)?.agent_id;
        if (agentId) void client.invalidateQueries({ queryKey: scriptKeys.agentScripts(agentId) });
        return;
      } else if (name === "agent.routines.changed") {
        const agentId = (data as { agent_id?: string } | null)?.agent_id;
        if (agentId) void client.invalidateQueries({ queryKey: scheduleKeys.agentSchedules(agentId) });
        void client.invalidateQueries({ queryKey: guildKeys.guildSchedules(guildId) });
        return;
      } else {
        void client.invalidateQueries({ queryKey: chatKeys.chatState(guildId) });
      }
      void client.invalidateQueries({ queryKey: agentKeys.agents(guildId) });
    },
  });
}

/**
 * Keeps the inbox current: its counts, and the unread count of each guild. Bursts of changes
 * collapse into one refetch. A message posted in a guild the operator can see also reaches
 * `onMessage`.
 */
export function useInboxStream(onMessage?: (notice: MessageNotice) => void): void {
  const client = useQueryClient();
  const pending = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(pending.current), []);
  const refetch = () => {
    clearTimeout(pending.current);
    pending.current = setTimeout(() => {
      void client.invalidateQueries({ queryKey: chatKeys.notifications });
    }, 150);
  };
  useEventStream("/api/notifications/stream", {
    events: ["notifications.changed", "notifications.message"],
    onOpen: refetch,
    onEvent: (name, data) => {
      refetch();
      if (name === "notifications.message" && data) onMessage?.(data as MessageNotice);
    },
    retryMs: 5000,
  });
}

const runEvents = [
  "generation.started",
  "assistant.reasoning.delta",
  "assistant.delta",
  "message.committed",
  "tool.progress",
  "run.error",
  "generation.finished",
  "run.continued",
] as const;

/** What a run's stream shows before it is committed: the turn being written, and running calls' progress. */
export type RunStreamState = { live: LiveTurn | null; progress: ToolProgress };

/**
 * Follows one open run: streamed reasoning and text arrive as `live`, the lines a running tool
 * call reports arrive as `progress` until its result is committed, committed rows go straight
 * into the cached transcript, and the end of a generation refreshes the run. A run that
 * continues in a new one of its chain hands `onContinued` the new run's id.
 */
export function useRunStream(
  agentId: string,
  runId: string | undefined,
  onContinued?: (nextRunId: string) => void,
): RunStreamState {
  const client = useQueryClient();
  const [live, setLive] = useState<LiveTurn | null>(null);
  const [progress, setProgress] = useState<ToolProgress>({});
  const [trackedRun, setTrackedRun] = useState(runId);
  if (trackedRun !== runId) {
    setTrackedRun(runId);
    setLive(null);
    setProgress({});
  }
  const refreshRun = () => {
    if (!runId) return;
    void client.invalidateQueries({ queryKey: runKeys.run(runId) });
    void client.invalidateQueries({ queryKey: runKeys.runMessages(runId) });
    void client.invalidateQueries({ queryKey: runKeys.agentRuns(agentId) });
    void client.invalidateQueries({ queryKey: agentKeys.agent(agentId) });
  };

  useEventStream(runId ? `/api/runs/${encodeURIComponent(runId)}/stream` : null, {
    events: runEvents,
    onOpen: refreshRun,
    onEvent: (name, data) => {
      if (!runId) return;
      if (name === "assistant.reasoning.delta" || name === "assistant.delta") {
        setLive((turn) => applyLiveDelta(turn, name, data));
        return;
      }
      if (name === "generation.started") {
        client.setQueryData<Run>(runKeys.run(runId), (run) =>
          run ? { ...run, generating: true } : run,
        );
        client.setQueryData<Run[]>(runKeys.agentRuns(agentId), (runs) =>
          runs?.map((run) => (run.id === runId ? { ...run, generating: true } : run)),
        );
        return;
      }
      if (name === "message.committed") {
        const message = data as RunMessage;
        client.setQueryData<RunMessage[]>(runKeys.runMessages(runId), (messages) =>
          messages && !messages.some((known) => known.seq === message.seq)
            ? [...messages, message].sort((a, b) => a.seq - b.seq)
            : messages,
        );
        if (message.payload.role === "assistant") setLive(null);
        // Files, scripts and routines follow the guild's stream; records follow the run's tools.
        if (message.payload.role === "tool") {
          setProgress((current) => dropToolProgress(current, message.payload.tool_call_id));
          void client.invalidateQueries({ queryKey: tableKeys.databases });
        }
        return;
      }
      if (name === "tool.progress") {
        setProgress((current) => applyToolProgress(current, data));
        return;
      }
      if (name === "generation.finished" || name === "run.error") {
        setLive(null);
        setProgress({});
        refreshRun();
        return;
      }
      if (name === "run.continued") {
        const next = (data as { run_id?: string } | null)?.run_id;
        refreshRun();
        if (next) onContinued?.(next);
      }
    },
  });

  return { live, progress };
}

const studioEvents = [
  "generation.started",
  "assistant.delta",
  "assistant.reasoning.delta",
  "message.committed",
  "draft.changed",
  "generation.finished",
  "session.error",
] as const;

/**
 * Follows a Studio session: the coach's reply as it is written, committed rows into the cached
 * conversation, and a refresh of drafts and state when the coach finishes or proposes a draft.
 */
export function useStudioStream(sessionId: string): LiveTurn | null {
  const client = useQueryClient();
  const [live, setLive] = useState<LiveTurn | null>(null);
  const [tracked, setTracked] = useState(sessionId);
  if (tracked !== sessionId) {
    setTracked(sessionId);
    setLive(null);
  }
  const refresh = () => void client.invalidateQueries({ queryKey: studioKeys.studio(sessionId) });

  useEventStream(`/api/studio/sessions/${encodeURIComponent(sessionId)}/stream`, {
    events: studioEvents,
    onOpen: refresh,
    onEvent: (name, data) => {
      if (name === "assistant.reasoning.delta" || name === "assistant.delta") {
        setLive((turn) => applyLiveDelta(turn, name, data));
        return;
      }
      if (name === "generation.started") {
        client.setQueryData<StudioSession>(studioKeys.studio(sessionId), (session) =>
          session ? { ...session, generation_state: "generating" } : session,
        );
        return;
      }
      if (name === "message.committed") {
        const message = (data as { message?: StudioMessage } | null)?.message;
        if (!message) return;
        client.setQueryData<StudioMessage[]>(studioKeys.studioMessages(sessionId), (messages) =>
          messages && !messages.some((known) => known.seq === message.seq)
            ? [...messages, message].sort((a, b) => a.seq - b.seq)
            : messages,
        );
        if (message.payload.role === "assistant") setLive(null);
        return;
      }
      if (name === "draft.changed") {
        refresh();
        return;
      }
      setLive(null);
      if (name === "generation.finished") {
        client.setQueryData<StudioSession>(studioKeys.studio(sessionId), (session) =>
          session ? { ...session, generation_state: "idle" } : session,
        );
      }
      refresh();
    },
  });
  return live;
}

const builderEvents = [
  "generation.started",
  "assistant.delta",
  "assistant.reasoning.delta",
  "message.committed",
  "recipe.changed",
  "generation.finished",
  "session.error",
] as const;

/**
 * Follows a Builder session: the coach's reply as it is written, committed rows into the cached
 * conversation, and the session and its recipe re-read when the coach writes the draft or stops.
 */
export function useBuilderStream(
  sessionId: string,
  onError: (detail: string) => void,
): LiveTurn | null {
  const client = useQueryClient();
  const [live, setLive] = useState<LiveTurn | null>(null);
  const [tracked, setTracked] = useState(sessionId);
  if (tracked !== sessionId) {
    setTracked(sessionId);
    setLive(null);
  }
  const refresh = () => {
    void client.invalidateQueries({ queryKey: builderKeys.builder(sessionId) });
    void client.invalidateQueries({ queryKey: recipeKeys.recipes });
  };

  useEventStream(`/api/builder/sessions/${encodeURIComponent(sessionId)}/stream`, {
    events: builderEvents,
    onOpen: refresh,
    onEvent: (name, data) => {
      if (name === "assistant.reasoning.delta" || name === "assistant.delta") {
        setLive((turn) => applyLiveDelta(turn, name, data));
        return;
      }
      if (name === "generation.started") {
        client.setQueryData<BuilderSession>(builderKeys.builder(sessionId), (session) =>
          session ? { ...session, generation_state: "generating" } : session,
        );
        return;
      }
      if (name === "message.committed") {
        const message = (data as { message?: StudioMessage } | null)?.message;
        if (!message) return;
        client.setQueryData<StudioMessage[]>(builderKeys.builderMessages(sessionId), (messages) =>
          messages && !messages.some((known) => known.seq === message.seq)
            ? [...messages, message].sort((a, b) => a.seq - b.seq)
            : messages,
        );
        if (message.payload.role === "assistant") setLive(null);
        return;
      }
      if (name === "recipe.changed") {
        refresh();
        return;
      }
      if (name === "session.error") {
        const detail = (data as { detail?: unknown } | null)?.detail;
        if (typeof detail === "string") onError(detail);
      }
      setLive(null);
      if (name === "generation.finished") {
        client.setQueryData<BuilderSession>(builderKeys.builder(sessionId), (session) =>
          session ? { ...session, generation_state: "idle" } : session,
        );
      }
      refresh();
    },
  });
  return live;
}
