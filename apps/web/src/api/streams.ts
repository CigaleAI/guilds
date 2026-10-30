import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import {
  builderEventGuards,
  dispatchLiveEvent,
  guildEventGuards,
  inboxEventGuards,
  parseFrameData,
  runEventGuards,
  studioEventGuards,
  type BuilderEvents,
  type GuildEvents,
  type InboxEvents,
  type LiveEventHandlers,
  type RunEvents,
  type StudioEvents,
} from "./liveEvents";
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
          if (!(event instanceof MessageEvent) || typeof event.data !== "string") return;
          latest.current.onEvent(name, parseFrameData(event.data));
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

const guildEvents = Object.keys(guildEventGuards);

/**
 * Keeps a guild's chat, agents, open issues, files and routines current: committed messages are
 * added to the cached history, a cleared chat empties it, chat state changes re-read the state and who is generating, a file
 * change refreshes every file read, and a routine or script change refreshes that agent's.
 */
export function useGuildStream(guildId: string): void {
  const client = useQueryClient();
  const showChatState = (state: GroupChatState) => {
    client.setQueryData<GroupChatState>(chatKeys.chatState(guildId), (previous) => ({
      ...state,
      seen_through_seq: previous?.seen_through_seq ?? null,
    }));
    void client.invalidateQueries({ queryKey: agentKeys.agents(guildId) });
  };
  const refreshChatState = () => {
    void client.invalidateQueries({ queryKey: chatKeys.chatState(guildId) });
    void client.invalidateQueries({ queryKey: agentKeys.agents(guildId) });
  };
  const handlers: LiveEventHandlers<GuildEvents> = {
    "group.message.committed": (message) => {
      client.setQueryData<GroupMessage[]>(chatKeys.chatMessages(guildId), (messages) =>
        messages && !messages.some((known) => known.seq === message.seq)
          ? [...messages, message].sort((a, b) => a.seq - b.seq)
          : messages,
      );
      void client.invalidateQueries({ queryKey: chatKeys.chatState(guildId) });
    },
    "group.cleared": (state) => showClearedGroupChat(client, guildId, state),
    "group.limit_reached": showChatState,
    "group.idle": showChatState,
    "group.delivery.started": refreshChatState,
    "group.delivery.finished": refreshChatState,
    "group.delivery.failed": refreshChatState,
    "guild.issues.changed": () =>
      void client.invalidateQueries({ queryKey: issueKeys.issues(guildId) }),
    "guild.artifacts.changed": () =>
      void client.invalidateQueries({ queryKey: noteKeys.artifacts }),
    "agent.routines.changed": (change) => {
      void client.invalidateQueries({ queryKey: scheduleKeys.agentSchedules(change.agent_id) });
      void client.invalidateQueries({ queryKey: guildKeys.guildSchedules(guildId) });
    },
    "agent.scripts.changed": (change) =>
      void client.invalidateQueries({ queryKey: scriptKeys.agentScripts(change.agent_id) }),
  };
  useEventStream(`/api/guilds/${encodeURIComponent(guildId)}/group-chat/stream`, {
    events: guildEvents,
    onOpen: () => {
      void client.invalidateQueries({ queryKey: chatKeys.chatMessages(guildId) });
      void client.invalidateQueries({ queryKey: chatKeys.chatState(guildId) });
      void client.invalidateQueries({ queryKey: agentKeys.agents(guildId) });
    },
    onEvent: (name, data) => dispatchLiveEvent(guildEventGuards, handlers, name, data),
  });
}

const inboxEvents = Object.keys(inboxEventGuards);

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
  const handlers: LiveEventHandlers<InboxEvents> = {
    "notifications.changed": refetch,
    "notifications.message": (notice) => {
      refetch();
      onMessage?.(notice);
    },
  };
  useEventStream("/api/notifications/stream", {
    events: inboxEvents,
    onOpen: refetch,
    onEvent: (name, data) => dispatchLiveEvent(inboxEventGuards, handlers, name, data),
    retryMs: 5000,
  });
}

const runEvents = Object.keys(runEventGuards);

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

  const showGenerationEnded = () => {
    setLive(null);
    setProgress({});
    refreshRun();
  };

  useEventStream(runId ? `/api/runs/${encodeURIComponent(runId)}/stream` : null, {
    events: runEvents,
    onOpen: refreshRun,
    onEvent: (name, data) => {
      if (!runId) return;
      const handlers: LiveEventHandlers<RunEvents> = {
        "generation.started": () => {
          client.setQueryData<Run>(runKeys.run(runId), (run) =>
            run ? { ...run, generating: true } : run,
          );
          client.setQueryData<Run[]>(runKeys.agentRuns(agentId), (runs) =>
            runs?.map((run) => (run.id === runId ? { ...run, generating: true } : run)),
          );
        },
        "assistant.reasoning.delta": (delta) =>
          setLive((turn) => applyLiveDelta(turn, "assistant.reasoning.delta", delta)),
        "assistant.delta": (delta) =>
          setLive((turn) => applyLiveDelta(turn, "assistant.delta", delta)),
        "message.committed": (message) => {
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
        },
        "tool.progress": (event) => setProgress((current) => applyToolProgress(current, event)),
        "run.error": showGenerationEnded,
        "generation.finished": showGenerationEnded,
        "run.continued": (continuation) => {
          refreshRun();
          onContinued?.(continuation.run_id);
        },
      };
      dispatchLiveEvent(runEventGuards, handlers, name, data);
    },
  });

  return { live, progress };
}

const studioEvents = Object.keys(studioEventGuards);

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

  const handlers: LiveEventHandlers<StudioEvents> = {
    "generation.started": () =>
      client.setQueryData<StudioSession>(studioKeys.studio(sessionId), (session) =>
        session ? { ...session, generation_state: "generating" } : session,
      ),
    "assistant.delta": (delta) => setLive((turn) => applyLiveDelta(turn, "assistant.delta", delta)),
    "assistant.reasoning.delta": (delta) =>
      setLive((turn) => applyLiveDelta(turn, "assistant.reasoning.delta", delta)),
    "message.committed": ({ message }) => {
      client.setQueryData<StudioMessage[]>(studioKeys.studioMessages(sessionId), (messages) =>
        messages && !messages.some((known) => known.seq === message.seq)
          ? [...messages, message].sort((a, b) => a.seq - b.seq)
          : messages,
      );
      if (message.payload.role === "assistant") setLive(null);
    },
    "draft.changed": refresh,
    "generation.finished": () => {
      setLive(null);
      client.setQueryData<StudioSession>(studioKeys.studio(sessionId), (session) =>
        session ? { ...session, generation_state: "idle" } : session,
      );
      refresh();
    },
    "session.error": () => {
      setLive(null);
      refresh();
    },
  };

  useEventStream(`/api/studio/sessions/${encodeURIComponent(sessionId)}/stream`, {
    events: studioEvents,
    onOpen: refresh,
    onEvent: (name, data) => dispatchLiveEvent(studioEventGuards, handlers, name, data),
  });
  return live;
}

const builderEvents = Object.keys(builderEventGuards);

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

  const handlers: LiveEventHandlers<BuilderEvents> = {
    "generation.started": () =>
      client.setQueryData<BuilderSession>(builderKeys.builder(sessionId), (session) =>
        session ? { ...session, generation_state: "generating" } : session,
      ),
    "assistant.delta": (delta) => setLive((turn) => applyLiveDelta(turn, "assistant.delta", delta)),
    "assistant.reasoning.delta": (delta) =>
      setLive((turn) => applyLiveDelta(turn, "assistant.reasoning.delta", delta)),
    "message.committed": ({ message }) => {
      client.setQueryData<StudioMessage[]>(builderKeys.builderMessages(sessionId), (messages) =>
        messages && !messages.some((known) => known.seq === message.seq)
          ? [...messages, message].sort((a, b) => a.seq - b.seq)
          : messages,
      );
      if (message.payload.role === "assistant") setLive(null);
    },
    "recipe.changed": refresh,
    "generation.finished": () => {
      setLive(null);
      client.setQueryData<BuilderSession>(builderKeys.builder(sessionId), (session) =>
        session ? { ...session, generation_state: "idle" } : session,
      );
      refresh();
    },
    "session.error": (failure) => {
      onError(failure.detail);
      setLive(null);
      refresh();
    },
  };

  useEventStream(`/api/builder/sessions/${encodeURIComponent(sessionId)}/stream`, {
    events: builderEvents,
    onOpen: refresh,
    onEvent: (name, data) => dispatchLiveEvent(builderEventGuards, handlers, name, data),
  });
  return live;
}
