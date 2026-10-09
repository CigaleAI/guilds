import { Link, useParams } from "@tanstack/react-router";
import { Plus, Repeat, Trash2 } from "lucide-react";
import { useMemo, useState, type ReactNode } from "react";
import {
  useAgent,
  useAgentRuns,
  useAgentSchedules,
  useDeleteSchedule,
  useGuild,
  useSetSchedulePaused,
} from "../../../api/queries";
import type { Run, Schedule } from "../../../api/types";
import { messageTime, upcomingTime } from "../../../app/format";
import {
  Button,
  Markdown,
  RoutineRow,
  Banner,
  EmptyState,
  SkeletonRows,
  ConfirmDialog,
  toast,
  Icon,
} from "@guildsrun/ui";
import type { RoutineState } from "@guildsrun/ui";
import { RoutineForm } from "./RoutineForm";

/** The mono form of a routine's timing: its cron, or its window's span, count and timezone. */
function timingText(routine: Schedule): string {
  if (routine.cron) return routine.cron;
  const win = routine.window;
  return win ? `${win.start}–${win.end} · ${win.max_wakes}× · ${win.timezone}` : "";
}

function routineState(routine: Schedule, guildOn: boolean): RoutineState {
  if (routine.paused) return { kind: "paused" };
  if (!guildOn) return { kind: "held" };
  return { kind: "active", next: routine.next_run_at ? upcomingTime(routine.next_run_at) : "—" };
}

/**
 * The agent's routines: when each wakes it and with what instruction. Routines are added, paused
 * and deleted here; an agent can also set its own from chat.
 */
export function AgentRoutines() {
  const { guildId, agentId } = useParams({ from: "/guilds/$guildId/agents/$agentId" });
  const agent = useAgent(agentId);
  const guild = useGuild(guildId);
  const routines = useAgentSchedules(agentId);
  const runs = useAgentRuns(agentId);
  const setPaused = useSetSchedulePaused(agentId);
  const remove = useDeleteSchedule(agentId);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [deleting, setDeleting] = useState<Schedule | null>(null);

  const guildOn = guild.data?.routines_enabled ?? true;
  const list = routines.data ?? [];
  const selected = list.find((routine) => routine.id === selectedId) ?? list[0];

  /** Each routine's wake-ups, newest first. */
  const wakes = useMemo(() => {
    const byRoutine = new Map<string, Run[]>();
    for (const run of runs.data ?? []) {
      if (run.kind !== "schedule" || !run.schedule_id) continue;
      byRoutine.set(run.schedule_id, [...(byRoutine.get(run.schedule_id) ?? []), run]);
    }
    for (const list of byRoutine.values())
      list.sort((a, b) => b.created_at.localeCompare(a.created_at));
    return byRoutine;
  }, [runs.data]);

  const agentName = agent.data?.name ?? "the agent";
  const newRoutine = (
    <Button size="sm" onClick={() => setAdding(true)} disabled={Boolean(agent.data?.archived_at)}>
      <Icon icon={Plus} size={14} />
      New routine
    </Button>
  );

  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-7 py-6">
      <div className="mx-auto flex max-w-240 flex-col gap-4">
        <div className="flex flex-wrap items-center gap-3">
          <p className="min-w-60 flex-1 text-sm text-fg-2">
            Cron wake-ups run in UTC; random windows run in their own timezone.
          </p>
          {list.length ? newRoutine : null}
        </div>

        {!guildOn ? (
          <Banner
            tone="warning"
            title="This guild's routines are off"
            action={
              <Button asChild variant="outline" size="sm">
                <Link to="/guilds/$guildId/routines" params={{ guildId }}>
                  Guild routines
                </Link>
              </Button>
            }
          >
            These wake-ups are held until an operator turns the guild's routines back on.
          </Banner>
        ) : null}

        {routines.isPending ? (
          <SkeletonRows rows={3} label="Loading routines" />
        ) : routines.isError ? (
          <Banner
            tone="error"
            title="Couldn't load the routines"
            meta={routines.error.message}
            action={
              <Button variant="outline" size="sm" onClick={() => void routines.refetch()}>
                Retry
              </Button>
            }
          />
        ) : list.length === 0 ? (
          <EmptyState
            icon={Repeat}
            title="No routines yet"
            description={`Add one to wake ${agentName} on a schedule, or ask it in chat to set one up.`}
            action={newRoutine}
          />
        ) : (
          <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
            <div className="flex flex-col gap-2">
              {list.map((routine) => (
                <RoutineRow
                  key={routine.id}
                  description={routine.description}
                  mode={routine.cron ? "cron" : "window"}
                  schedule={timingText(routine)}
                  scheduleLabel={routine.label}
                  state={routineState(routine, guildOn)}
                  selected={routine.id === selected?.id}
                  onSelect={() => setSelectedId(routine.id)}
                  onPausedChange={(paused) =>
                    setPaused.mutate(
                      { scheduleId: routine.id, paused },
                      {
                        onError: (error) =>
                          toast({
                            kind: "error",
                            title: paused
                              ? "Couldn't pause the routine"
                              : "Couldn't resume the routine",
                            description: error.message,
                          }),
                      },
                    )
                  }
                  disabled={setPaused.isPending && setPaused.variables.scheduleId === routine.id}
                />
              ))}
            </div>
            {selected ? (
              <RoutineDetail
                routine={selected}
                wakes={wakes.get(selected.id) ?? []}
                guildId={guildId}
                agentId={agentId}
                onDelete={() => setDeleting(selected)}
              />
            ) : null}
          </div>
        )}
      </div>

      <RoutineForm agentId={agentId} agentName={agentName} open={adding} onOpenChange={setAdding} />
      <ConfirmDialog
        kind="destructive"
        open={deleting !== null}
        onOpenChange={(open) => !open && setDeleting(null)}
        title="Delete this routine?"
        description={`${agentName} stops waking for “${deleting?.description ?? ""}”. Its past wake-ups stay in History.`}
        confirmLabel="Delete routine"
        onConfirm={() =>
          deleting
            ? remove.mutateAsync(deleting.id).then(
                () => {
                  setDeleting(null);
                  setSelectedId(null);
                  toast({ kind: "success", title: "Routine deleted" });
                },
                (error: Error) => {
                  toast({
                    kind: "error",
                    title: "Couldn't delete the routine",
                    description: error.message,
                  });
                  throw error;
                },
              )
            : undefined
        }
      />
    </div>
  );
}

type RoutineDetailProps = {
  routine: Schedule;
  wakes: Run[];
  guildId: string;
  agentId: string;
  onDelete: () => void;
};

function Facts({ items }: { items: { term: string; value: ReactNode }[] }) {
  return (
    <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1.5 text-sm">
      {items.map(({ term, value }) => (
        <div key={term} className="contents">
          <dt className="text-muted">{term}</dt>
          <dd className="min-w-0">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

/** One routine in full: its timing in words, its instruction, and its wake-ups so far. */
function RoutineDetail({ routine, wakes, guildId, agentId, onDelete }: RoutineDetailProps) {
  const last = wakes[0];
  return (
    <section
      aria-label={routine.description}
      className="flex flex-col gap-4 rounded-lg bg-surface p-4"
    >
      <div className="flex flex-col gap-1">
        <h3 className="text-lg font-semibold">{routine.description}</h3>
        <p className="text-sm text-fg-2">{routine.label}</p>
      </div>
      <Facts
        items={[
          {
            term: "Next wake",
            value: routine.paused
              ? "Paused"
              : routine.next_run_at
                ? messageTime(routine.next_run_at)
                : "—",
          },
          {
            term: "Last wake",
            value: last ? (
              <Link
                to="/guilds/$guildId/agents/$agentId"
                params={{ guildId, agentId }}
                search={{ run: last.id }}
                className="text-signal-t underline-offset-2 hover:underline"
              >
                {messageTime(last.created_at)}
              </Link>
            ) : routine.last_run_at ? (
              messageTime(routine.last_run_at)
            ) : (
              "Not yet"
            ),
          },
          { term: "Wake-ups", value: String(wakes.length) },
          { term: "Added", value: messageTime(routine.created_at) },
        ]}
      />
      <div className="flex flex-col gap-1.5">
        <span className="type-label text-muted">Instruction</span>
        <div className="rounded-md bg-paper px-3 py-2.5">
          <Markdown density="compact">{routine.instruction}</Markdown>
        </div>
      </div>
      <Button variant="danger" size="sm" className="self-start" onClick={onDelete}>
        <Icon icon={Trash2} size={14} />
        Delete routine
      </Button>
    </section>
  );
}
