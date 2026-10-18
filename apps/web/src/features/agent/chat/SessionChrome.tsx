import { useNavigate, useParams, useSearch } from "@tanstack/react-router";
import { useEffect } from "react";
import { Clock, Plus } from "lucide-react";
import { useAgentRuns, useAgentSchedules, useRun } from "../../../api/queries";
import type { Run, Schedule } from "../../../api/types";
import { messageTime } from "../../../app/format";
import { IconButton, StatusBadge, Tooltip } from "@guildsrun/ui";
import { runState, runTitle } from "../runState";
import { heldChatRun, holdChatRun, useHeldChatRun } from "./chatLinger";

type ChatSearch = {
  run?: string;
  call?: string;
  seq?: number;
  history?: true;
};

/** Keeps the open run and history drawer in the Chat search when one of them changes. */
function nextChatSearch(current: ChatSearch, patch: { run?: string | null; history?: boolean }) {
  const run = patch.run === null ? undefined : patch.run !== undefined ? patch.run : current.run;
  const runChanged = patch.run !== undefined;
  const history = patch.history === undefined ? Boolean(current.history) : patch.history;
  return {
    ...(run
      ? {
          run,
          ...(!runChanged && current.call ? { call: current.call } : {}),
          ...(!runChanged && current.seq !== undefined ? { seq: current.seq } : {}),
        }
      : {}),
    ...(history ? { history: true as const } : {}),
  };
}

export function runLabel(run: Run, schedules: readonly Schedule[] | undefined): string {
  return `${runTitle(run, schedules)} · ${messageTime(run.created_at)}`;
}

export function RunStatus({ run, className }: { run: Run; className?: string }) {
  const state = runState(run);
  return (
    <StatusBadge
      status={state.status}
      className={className}
      {...(state.detail ? { title: state.detail } : {})}
    >
      {state.label}
    </StatusBadge>
  );
}

/**
 * The open session, shared by the chat and the tab-strip chrome. A generating run is held so the
 * transcript stays when that generation finishes; plus or a row in history replaces the hold, and
 * a new session opened with plus stays open while another run is generating.
 */
export function useChatSession() {
  const { guildId, agentId } = useParams({ from: "/guilds/$guildId/agents/$agentId" });
  const search = useSearch({ from: "/guilds/$guildId/agents/$agentId" });
  const navigate = useNavigate();
  const runs = useAgentRuns(agentId);
  const schedules = useAgentSchedules(agentId);
  const generatingId = runs.data?.find((candidate) => candidate.generating)?.id;
  useEffect(() => {
    if (generatingId && heldChatRun(agentId) !== null) holdChatRun(agentId, generatingId);
  }, [agentId, generatingId]);
  const held = useHeldChatRun(agentId);
  const runId = search.run ?? (held === null ? undefined : (generatingId ?? held));
  const run = useRun(runId);

  const go = (patch: { run?: string | null; history?: boolean }) => {
    void navigate({
      to: "/guilds/$guildId/agents/$agentId",
      params: { guildId, agentId },
      search: nextChatSearch(search, patch),
    });
  };
  const selectRun = (id: string | null) => {
    holdChatRun(agentId, id);
    go({ run: id });
  };
  const toggleHistory = () => go({ history: !search.history });

  const recent = (runs.data ?? []).slice(0, 12);

  return {
    guildId,
    agentId,
    search,
    runs,
    schedules,
    runId,
    run,
    selectRun,
    toggleHistory,
    recent,
  };
}

/** Clock opens the session drawer; plus starts a new session. */
export function ChatSessionChrome() {
  const { search, selectRun, toggleHistory } = useChatSession();

  return (
    <div className="flex shrink-0 items-center gap-1 border-l border-line py-1 pr-3 pl-2 md:pr-6">
      <Tooltip label={search.history ? "Hide history" : "Session history"}>
        <IconButton
          icon={Clock}
          label={search.history ? "Hide history" : "Session history"}
          variant={search.history ? "ink" : "ghost"}
          size={28}
          onClick={toggleHistory}
        />
      </Tooltip>
      <Tooltip label="New session">
        <IconButton
          icon={Plus}
          label="New session"
          variant="ghost"
          size={28}
          onClick={() => selectRun(null)}
        />
      </Tooltip>
    </div>
  );
}
