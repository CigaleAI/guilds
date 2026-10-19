import { Link } from "@tanstack/react-router";
import { ExternalLink, Pin } from "lucide-react";
import { useStudioInspector, useStudioRoutines, useStudioRuns } from "../../../api/queries";
import type { StudioAgent, StudioRoutine } from "../../../api/types";
import { clockTime, dayLabel, relativeTime, upcomingTime } from "../../../app/format";
import { Button, Markdown, Banner, SkeletonRows, Icon, Row, Tag } from "@guildsrun/ui";
import { DetailHeader, Empty, MasterDetail } from "../MasterDetail";
import { useStudio } from "../StudioContext";
import { RunRow } from "./HistoryTab";

/** Active routines first, each group by its next wake. */
function byNextWake(a: StudioRoutine, b: StudioRoutine): number {
  if (a.paused !== b.paused) return a.paused ? 1 : -1;
  return (a.next_run_at ?? "").localeCompare(b.next_run_at ?? "");
}

function nextWake(routine: StudioRoutine): string {
  if (routine.paused) return "paused";
  return routine.next_run_at ? `next ${upcomingTime(routine.next_run_at)}` : "not scheduled";
}

/** The agent's routines: each one's instruction, when it wakes next, and the runs it started. */
export function RoutinesTab({ agent }: { agent: StudioAgent }) {
  const { session, search, go } = useStudio();
  const routines = useStudioRoutines(session.id, agent.id);

  if (routines.isPending) {
    return <SkeletonRows rows={4} label="Loading routines" className="p-5" />;
  }
  if (routines.isError) {
    return (
      <div className="p-5">
        <Banner tone="error" title="Couldn't load the routines" meta={routines.error.message} />
      </div>
    );
  }

  const sorted = [...routines.data].sort(byNextWake);
  const active = sorted.filter((routine) => !routine.paused).length;
  const selected = sorted.find((routine) => routine.id === search.item) ?? sorted[0];

  return (
    <MasterDetail
      listLabel={`${agent.name}'s routines`}
      toolbar={
        <span className="type-meta text-muted">
          {sorted.length} routine{sorted.length === 1 ? "" : "s"}
          {sorted.length ? ` · ${active} active` : ""}
        </span>
      }
      list={
        sorted.length ? (
          sorted.map((routine) => {
            const isSelected = routine.id === selected?.id;
            return (
              <Row
                key={routine.id}
                asChild
                density="compact"
                interactive
                selected={isSelected}
                title={routine.description || routine.label}
                meta={`${routine.label} · ${nextWake(routine)}`}
                trail={
                  <Tag tone={isSelected ? "on-plum" : "well"} font="sans">
                    {routine.run_count} run{routine.run_count === 1 ? "" : "s"}
                  </Tag>
                }
              >
                <button
                  type="button"
                  aria-current={isSelected ? "true" : undefined}
                  onClick={() =>
                    go(
                      { section: "agents", agent: agent.id, tab: "routines", item: routine.id },
                      { replace: true },
                    )
                  }
                />
              </Row>
            );
          })
        ) : (
          <Empty>No routines.</Empty>
        )
      }
      detail={
        selected ? (
          <RoutineDetail key={selected.id} agent={agent} routine={selected} />
        ) : (
          <Empty>
            This agent has no routines. Add one from its Routine tab, or ask it to in chat.
          </Empty>
        )
      }
    />
  );
}

function RoutineDetail({ agent, routine }: { agent: StudioAgent; routine: StudioRoutine }) {
  const { session, go, ask } = useStudio();
  const runs = useStudioRuns(session.id, agent.id);
  const inspector = useStudioInspector(session.id, agent.id);
  const fired = (runs.data ?? []).filter((run) => run.schedule_id === routine.id);
  const title = routine.description || routine.label;

  return (
    <>
      <DetailHeader
        title={title}
        meta={
          <span className="flex flex-wrap gap-x-2">
            {routine.cron ? <span className="font-mono">{routine.cron}</span> : null}
            <span>{routine.label}</span>
            <span>{nextWake(routine)}</span>
            <span>last {routine.last_run_at ? relativeTime(routine.last_run_at) : "never"}</span>
          </span>
        }
        actions={
          <>
            <Button asChild variant="outline" size="sm">
              <Link
                to="/guilds/$guildId/agents/$agentId/routine"
                params={{ guildId: session.source_guild_id, agentId: agent.id }}
              >
                <Icon icon={ExternalLink} size={14} />
                Edit in agent
              </Link>
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() =>
                ask({
                  kind: "routine",
                  agent_id: agent.id,
                  schedule_id: routine.id,
                  label: `${agent.name} · routine · ${title}`,
                })
              }
            >
              <Icon icon={Pin} size={14} />
              Ask the coach
            </Button>
          </>
        }
      />
      {routine.guild_routines_enabled === false ? (
        <Banner tone="info" title="The guild's routines are off">
          This routine is held and does not fire until they are turned back on.
        </Banner>
      ) : null}
      <section className="flex flex-col gap-2">
        <h3 className="type-label text-muted">Instruction</h3>
        <div className="rounded-lg bg-surface px-4 py-3">
          <Markdown density="compact">{routine.instruction}</Markdown>
        </div>
        <p className="text-xs text-muted">
          Created {dayLabel(routine.created_at)} {clockTime(routine.created_at)}
          {routine.updated_at !== routine.created_at
            ? ` · updated ${relativeTime(routine.updated_at)}`
            : ""}
        </p>
      </section>
      <section className="flex flex-col gap-1">
        <h3 className="type-label text-muted">
          Runs it started · {fired.length}
          {routine.run_count > fired.length ? ` of ${routine.run_count}` : ""}
        </h3>
        {runs.isPending ? (
          <SkeletonRows rows={3} label="Loading runs" />
        ) : fired.length ? (
          fired.map((run) => (
            <RunRow
              key={run.id}
              run={run}
              routines={undefined}
              currentTask={inspector.data?.task.effective_hash}
              selected={false}
              title={relativeTime(run.created_at)}
              {...(run.instruction_hash && run.instruction_hash !== routine.instruction_hash
                ? { note: "older instruction" }
                : {})}
              onSelect={() =>
                go({ section: "agents", agent: agent.id, tab: "history", item: run.id })
              }
            />
          ))
        ) : (
          <Empty>This routine has not fired yet.</Empty>
        )}
      </section>
    </>
  );
}
