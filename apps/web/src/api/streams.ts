import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { keys } from "./queries";
import type { GroupChatState, GroupMessage, RunMessage, StudioMessage } from "./types";

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
  "group.limit_reached",
  "group.idle",
  "group.delivery.started",
  "group.delivery.finished",
  "group.delivery.failed",
  "guild.issues.changed",
  "guild.files.changed",
  "agent.routines.changed",
  "agent.scripts.changed",
] as const;

/**
 * Keeps a guild's chat, agents, open issues, files and routines current: committed messages are
 * added to the cached history, chat state changes re-read the state and who is generating, a file
 * change refreshes every file read, and a routine or script change refreshes that agent's.
 */
export function useGuildStream(guildId: string): void {
  const client = useQueryClient();
  useEventStream(`/api/guilds/${encodeURIComponent(guildId)}/group-chat/stream`, {
    events: guildEvents,
    onOpen: () => {
      void client.invalidateQueries({ queryKey: keys.chatMessages(guildId) });
      void client.invalidateQueries({ queryKey: keys.chatState(guildId) });
      void client.invalidateQueries({ queryKey: keys.agents(guildId) });
    },
    onEvent: (name, data) => {
      if (name === "group.message.committed") {
        const message = data as GroupMessage;
        client.setQueryData<GroupMessage[]>(keys.chatMessages(guildId), (messages) =>
          messages && !messages.some((known) => known.seq === message.seq)
            ? [...messages, message].sort((a, b) => a.seq - b.seq)
            : messages,
        );
        void client.invalidateQueries({ queryKey: keys.chatState(guildId) });
        return;
      }
      if (name === "group.idle" || name === "group.limit_reached") {
        const state = data as GroupChatState;
        client.setQueryData<GroupChatState>(keys.chatState(guildId), (previous) => ({
          ...state,
          seen_through_seq: previous?.seen_through_seq ?? null,
        }));
      } else if (name === "guild.issues.changed") {
        void client.invalidateQueries({ queryKey: keys.issues(guildId) });
        return;
      } else if (name === "guild.files.changed") {
        void client.invalidateQueries({ queryKey: keys.files });
        return;
      } else if (name === "agent.scripts.changed") {
        const agentId = (data as { agent_id?: string } | null)?.agent_id;
        if (agentId) void client.invalidateQueries({ queryKey: keys.agentScripts(agentId) });
        return;
      } else if (name === "agent.routines.changed") {
        const agentId = (data as { agent_id?: string } | null)?.agent_id;
        if (agentId) void client.invalidateQueries({ queryKey: keys.agentSchedules(agentId) });
        void client.invalidateQueries({ queryKey: keys.guildSchedules(guildId) });
        return;
      } else {
        void client.invalidateQueries({ queryKey: keys.chatState(guildId) });
      }
      void client.invalidateQueries({ queryKey: keys.agents(guildId) });
    },
  });
}

/** Keeps the inbox count current; bursts of changes collapse into one refetch. */
export function useInboxStream(): void {
  const client = useQueryClient();
  const pending = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(pending.current), []);
  const refetch = () => {
    clearTimeout(pending.current);
    pending.current = setTimeout(() => {
      void client.invalidateQueries({ queryKey: keys.notifications });
    }, 150);
  };
  useEventStream("/api/notifications/stream", {
    events: ["notifications.changed"],
    onOpen: refetch,
    onEvent: refetch,
    retryMs: 5000,
  });
}

const runEvents = [
  "generation.started",
  "assistant.reasoning.delta",
  "assistant.delta",
  "message.committed",
  "run.error",
  "generation.finished",
  "run.continued",
] as const;

/** What the model is writing right now, before its turn is committed. */
export type LiveTurn = { reasoning: string; text: string };

/**
 * Follows one run while it generates: streamed reasoning and text arrive as `LiveTurn`, committed
 * rows go straight into the cached transcript, and the end of a generation refreshes the run. A
 * run that continues in a new one of its chain hands `onContinued` the new run's id.
 */
export function useRunStream(
  agentId: string,
  runId: string | undefined,
  generating: boolean,
  onContinued?: (nextRunId: string) => void,
): LiveTurn | null {
  const client = useQueryClient();
  const [live, setLive] = useState<LiveTurn | null>(null);
  const [trackedRun, setTrackedRun] = useState(runId);
  if (trackedRun !== runId) {
    setTrackedRun(runId);
    setLive(null);
  }
  const refreshRun = () => {
    if (!runId) return;
    void client.invalidateQueries({ queryKey: keys.run(runId) });
    void client.invalidateQueries({ queryKey: keys.runMessages(runId) });
    void client.invalidateQueries({ queryKey: keys.agentRuns(agentId) });
    void client.invalidateQueries({ queryKey: keys.agent(agentId) });
  };

  useEventStream(runId && generating ? `/api/runs/${encodeURIComponent(runId)}/stream` : null, {
    events: runEvents,
    onOpen: refreshRun,
    onEvent: (name, data) => {
      if (!runId) return;
      if (name === "assistant.reasoning.delta" || name === "assistant.delta") {
        const text = (data as { text?: string } | null)?.text ?? "";
        setLive((turn) => {
          const next = turn ?? { reasoning: "", text: "" };
          return name === "assistant.delta"
            ? { ...next, text: next.text + text }
            : { ...next, reasoning: next.reasoning + text };
        });
        return;
      }
      if (name === "message.committed") {
        const message = data as RunMessage;
        client.setQueryData<RunMessage[]>(keys.runMessages(runId), (messages) =>
          messages && !messages.some((known) => known.seq === message.seq)
            ? [...messages, message].sort((a, b) => a.seq - b.seq)
            : messages,
        );
        if (message.payload.role === "assistant") setLive(null);
        // Files, scripts and routines follow the guild's stream; records follow the run's tools.
        if (message.payload.role === "tool") {
          void client.invalidateQueries({ queryKey: keys.databases });
        }
        return;
      }
      if (name === "generation.finished" || name === "run.error") {
        setLive(null);
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

  return live;
}

const studioEvents = [
  "assistant.delta",
  "message.committed",
  "draft.changed",
  "generation.finished",
  "session.error",
] as const;

/**
 * Follows a Studio session: the coach's reply as it is written, committed rows into the cached
 * conversation, and a refresh of drafts and state when the coach finishes or proposes a draft.
 */
export function useStudioStream(
  sessionId: string,
  onDraft: (draft: { target_agent_id?: string }) => void,
): string {
  const client = useQueryClient();
  const [live, setLive] = useState("");
  const [tracked, setTracked] = useState(sessionId);
  if (tracked !== sessionId) {
    setTracked(sessionId);
    setLive("");
  }
  const refresh = () => void client.invalidateQueries({ queryKey: ["studio", sessionId] });

  useEventStream(`/api/studio/sessions/${encodeURIComponent(sessionId)}/stream`, {
    events: studioEvents,
    onOpen: refresh,
    onEvent: (name, data) => {
      if (name === "assistant.delta") {
        const text = (data as { content?: string } | null)?.content ?? "";
        setLive((current) => current + text);
        return;
      }
      if (name === "message.committed") {
        const message = (data as { message?: StudioMessage } | null)?.message;
        if (!message) return;
        client.setQueryData<StudioMessage[]>(["studio", sessionId, "messages"], (messages) =>
          messages && !messages.some((known) => known.seq === message.seq)
            ? [...messages, message].sort((a, b) => a.seq - b.seq)
            : messages,
        );
        if (message.payload.role === "assistant") setLive("");
        return;
      }
      if (name === "draft.changed") {
        onDraft((data as { draft?: { target_agent_id?: string } } | null)?.draft ?? {});
      }
      setLive("");
      refresh();
    },
  });
  return live;
}

const builderEvents = [
  "assistant.delta",
  "message.committed",
  "recipe.changed",
  "generation.finished",
  "session.error",
];

/**
 * Follows a Builder session: the coach's reply as it is written, committed rows into the cached
 * conversation, and the session and its recipe re-read when the coach writes the draft or stops.
 */
export function useBuilderStream(sessionId: string, onError: (detail: string) => void): string {
  const client = useQueryClient();
  const [live, setLive] = useState("");
  const [tracked, setTracked] = useState(sessionId);
  if (tracked !== sessionId) {
    setTracked(sessionId);
    setLive("");
  }
  const refresh = () => {
    void client.invalidateQueries({ queryKey: ["builder", sessionId] });
    void client.invalidateQueries({ queryKey: ["recipes"] });
  };

  useEventStream(`/api/builder/sessions/${encodeURIComponent(sessionId)}/stream`, {
    events: builderEvents,
    onOpen: refresh,
    onEvent: (name, data) => {
      if (name === "assistant.delta") {
        const body = data as { content?: string; text?: string } | null;
        setLive((current) => current + (body?.content ?? body?.text ?? ""));
        return;
      }
      if (name === "message.committed") {
        const message = (data as { message?: StudioMessage } | null)?.message;
        if (!message) return;
        client.setQueryData<StudioMessage[]>(["builder", sessionId, "messages"], (messages) =>
          messages && !messages.some((known) => known.seq === message.seq)
            ? [...messages, message].sort((a, b) => a.seq - b.seq)
            : messages,
        );
        if (message.payload.role === "assistant") setLive("");
        return;
      }
      if (name === "session.error") {
        const detail = (data as { detail?: unknown } | null)?.detail;
        if (typeof detail === "string") onError(detail);
      }
      setLive("");
      refresh();
    },
  });
  return live;
}
