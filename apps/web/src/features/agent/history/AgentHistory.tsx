import { Navigate, useParams } from "@tanstack/react-router";
import { History, MessagesSquare, Plus, Repeat, User, type LucideIcon } from "lucide-react";
import { useMemo, useState } from "react";
import { useAgentRuns } from "../../../api/queries/runs";
import { useAgentSchedules } from "../../../api/queries/schedules";
import type { Run, RunKind } from "../../../api/types/runs";
import { clockTime, dayKey, dayLabel, isoTime } from "../../../app/format";
import {
  Button,
  Segmented,
  ListGroupLabel,
  Banner,
  EmptyState,
  SkeletonRows,
  StatusBadge,
  Icon,
  Row,
  Tile,
} from "@guildsrun/ui";
import { runState, runTitle } from "../runState";

type KindFilter = "all" | RunKind;

const kindIcon: Record<RunKind, LucideIcon> = {
  direct: User,
  group: MessagesSquare,
  schedule: Repeat,
};
const kindFilterLabel: Record<RunKind, string> = {
  direct: "Direct",
  group: "Group chat",
  schedule: "Routine",
};
const kinds: RunKind[] = ["direct", "group", "schedule"];

/** Rows shown at first and added by each "Show more". */
const pageSize = 50;

type AgentHistoryListProps = {
  /** The session open in Chat, so its row is selected. */
  selectedId?: string;
  onSelect: (id: string | null) => void;
};

/** Every session of one agent, newest first by day; a row opens that session in Chat. */
export function AgentHistoryList({ selectedId, onSelect }: AgentHistoryListProps) {
  const { agentId } = useParams({ from: "/guilds/$guildId/agents/$agentId" });
  const runs = useAgentRuns(agentId);
  const schedules = useAgentSchedules(agentId);
  const [filter, setFilter] = useState<KindFilter>("all");
  const [shown, setShown] = useState(pageSize);

  const sorted = useMemo(
    () => [...(runs.data ?? [])].sort((a, b) => b.created_at.localeCompare(a.created_at)),
    [runs.data],
  );
  const counts = useMemo(() => {
    const byKind: Record<RunKind, number> = { direct: 0, group: 0, schedule: 0 };
    for (const run of sorted) byKind[run.kind] += 1;
    return byKind;
  }, [sorted]);
  const listed = filter === "all" ? sorted : sorted.filter((run) => run.kind === filter);
  const visible = listed.slice(0, shown);
  const days = useMemo(() => {
    const groups: { key: string; label: string; runs: Run[] }[] = [];
    for (const run of visible) {
      const key = dayKey(run.created_at);
      const last = groups.at(-1);
      if (last?.key === key) last.runs.push(run);
      else groups.push({ key, label: dayLabel(run.created_at), runs: [run] });
    }
    return groups;
  }, [visible]);

  const newSession = (
    <Button variant="outline" size="sm" onClick={() => onSelect(null)}>
      <Icon icon={Plus} size={14} />
      New session
    </Button>
  );

  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-3 py-3">
      <div className="flex flex-col gap-3">
        {runs.isPending ? (
          <SkeletonRows rows={6} label="Loading sessions" />
        ) : runs.isError ? (
          <Banner
            tone="error"
            title="Couldn't load the sessions"
            meta={runs.error.message}
            action={
              <Button variant="outline" size="sm" onClick={() => void runs.refetch()}>
                Retry
              </Button>
            }
          />
        ) : sorted.length === 0 ? (
          <EmptyState
            icon={History}
            title="No sessions yet"
            description="Sessions appear here once the agent is messaged, tagged in the group chat or woken by a routine."
            action={newSession}
          />
        ) : (
          <>
            <div className="flex flex-wrap items-center gap-2">
              <Segmented
                size="sm"
                label="Session type"
                value={filter}
                onValueChange={(value) => {
                  setFilter(value);
                  setShown(pageSize);
                }}
                options={[
                  { value: "all", label: "All", count: sorted.length },
                  ...kinds
                    .filter((kind) => counts[kind] > 0)
                    .map((kind) => ({
                      value: kind,
                      label: kindFilterLabel[kind],
                      count: counts[kind],
                    })),
                ]}
              />
              <span className="ml-auto type-meta text-muted">
                {listed.length} session{listed.length === 1 ? "" : "s"}
              </span>
              {newSession}
            </div>

            {days.map((day) => (
              <section key={day.key} aria-label={day.label} className="flex flex-col gap-1">
                <ListGroupLabel className="px-1 pt-1">{day.label}</ListGroupLabel>
                {day.runs.map((run) => {
                  const state = runState(run);
                  return (
                    <Row
                      key={run.id}
                      asChild
                      density="compact"
                      tone="surface"
                      interactive
                      selected={run.id === selectedId}
                      lead={
                        <Tile size={32} tone="paper">
                          <Icon icon={kindIcon[run.kind]} size={14} />
                        </Tile>
                      }
                      title={runTitle(run, schedules.data)}
                      meta={
                        <>
                          <time dateTime={isoTime(run.created_at)}>
                            {clockTime(run.created_at)}
                          </time>
                          {run.kind === "group" && run.group_chat_through_seq !== null
                            ? ` · up to message ${run.group_chat_through_seq}`
                            : null}
                        </>
                      }
                      trail={
                        <>
                          <StatusBadge
                            status={state.status}
                            {...(state.detail ? { title: state.detail } : {})}
                          >
                            {state.label}
                          </StatusBadge>
                        </>
                      }
                    >
                      <button type="button" onClick={() => onSelect(run.id)} />
                    </Row>
                  );
                })}
              </section>
            ))}

            {listed.length > shown ? (
              <Button
                variant="outline"
                size="md"
                className="self-center"
                onClick={() => setShown(shown + pageSize)}
              >
                Show {Math.min(pageSize, listed.length - shown)} more
              </Button>
            ) : null}
          </>
        )}
      </div>
    </div>
  );
}

/** Old History tab URL: open Chat with the session drawer expanded. */
export function AgentHistoryRedirect() {
  const { guildId, agentId } = useParams({ from: "/guilds/$guildId/agents/$agentId/history" });
  return (
    <Navigate
      to="/guilds/$guildId/agents/$agentId"
      params={{ guildId, agentId }}
      search={{ history: true }}
      replace
    />
  );
}
