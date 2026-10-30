import { Link, useNavigate, useParams } from "@tanstack/react-router";
import { Repeat } from "lucide-react";
import { useMemo } from "react";
import { useGuild, useUpdateGuild } from "../../../api/queries/guilds";
import { useGuildSchedules, useSetGuildSchedulePaused } from "../../../api/queries/schedules";
import type { GuildSchedule } from "../../../api/types/schedules";
import { agentLook } from "../../../app/agents";
import { upcomingTime } from "../../../app/format";
import {
  Button,
  OnOffSwitch,
  RoutineRow,
  Banner,
  EmptyState,
  SkeletonRows,
  Avatar,
  toast,
} from "@guildsrun/ui";
import type { RoutineState } from "@guildsrun/ui";
import { GuildPage } from "./GuildPage";

function timingText(routine: GuildSchedule): string {
  if (routine.cron) return routine.cron;
  const win = routine.window;
  return win ? `${win.start}–${win.end} · ${win.max_wakes}× · ${win.timezone}` : "";
}

/** Running routines first, soonest wake first. */
function byNextWake(a: GuildSchedule, b: GuildSchedule): number {
  if (a.paused !== b.paused) return a.paused ? 1 : -1;
  const next = (a.next_run_at ?? "").localeCompare(b.next_run_at ?? "");
  return next || a.created_at.localeCompare(b.created_at);
}

type RoutinesSwitchProps = {
  guildId: string;
  routines: readonly GuildSchedule[] | undefined;
};

/** The switch that holds every routine in the guild, with how many run, wait held, or are paused. */
function RoutinesSwitch({ guildId, routines }: RoutinesSwitchProps) {
  const guild = useGuild(guildId);
  const update = useUpdateGuild(guildId);
  const on = guild.data?.routines_enabled ?? true;
  const all = routines ?? [];
  const paused = all.filter((routine) => routine.paused).length;
  const running = all.length - paused;
  const summary = [
    on ? `${running} active` : running ? `${running} held` : "",
    paused ? `${paused} paused` : "",
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <div className="flex flex-wrap items-center gap-4 rounded-xl bg-surface p-4">
      <div className="flex min-w-60 flex-1 flex-col gap-0.5">
        <span className="text-md font-semibold">{on ? "Routines on" : "Routines off"}</span>
        <span className="text-sm text-fg-2">
          Turn off to hold every wake-up in this guild; turning back on plans missed ones from now.
        </span>
      </div>
      {summary ? <span className="type-meta text-muted">{summary}</span> : null}
      <OnOffSwitch
        label="Routines in this guild"
        value={on}
        disabled={!guild.data || update.isPending}
        onValueChange={(next) =>
          update.mutate(
            { routines_enabled: next },
            {
              onError: (error) =>
                toast({
                  kind: "error",
                  title: "Couldn't switch the guild's routines",
                  description: error.message,
                }),
            },
          )
        }
      />
    </div>
  );
}

/**
 * Every routine in the guild, by agent, and the switch that holds them all. Routines are added and
 * deleted from their agent's Routine tab.
 */
export function GuildRoutines() {
  const { guildId } = useParams({ from: "/guilds/$guildId" });
  const navigate = useNavigate();
  const guild = useGuild(guildId);
  const routines = useGuildSchedules(guildId);
  const setPaused = useSetGuildSchedulePaused(guildId);
  const on = guild.data?.routines_enabled ?? true;

  const groups = useMemo(() => {
    const byAgent = new Map<string, { agent: GuildSchedule["agent"]; routines: GuildSchedule[] }>();
    for (const routine of routines.data ?? []) {
      const group = byAgent.get(routine.agent_id) ?? { agent: routine.agent, routines: [] };
      group.routines.push(routine);
      byAgent.set(routine.agent_id, group);
    }
    return [...byAgent.values()].map((group) => ({
      ...group,
      routines: group.routines.sort(byNextWake),
    }));
  }, [routines.data]);

  const stateOf = (routine: GuildSchedule): RoutineState =>
    routine.paused
      ? { kind: "paused" }
      : !on
        ? { kind: "held" }
        : { kind: "active", next: routine.next_run_at ? upcomingTime(routine.next_run_at) : "—" };

  return (
    <GuildPage>
      <RoutinesSwitch guildId={guildId} routines={routines.data} />

      {routines.isPending ? (
        <SkeletonRows rows={4} label="Loading routines" />
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
      ) : groups.length === 0 ? (
        <EmptyState
          icon={Repeat}
          title="No routines yet"
          description="Agents get wake-ups from their Routine tab, or by setting one up in chat."
        />
      ) : (
        groups.map(({ agent, routines: list }) => (
          <section key={agent.id} aria-label={agent.name} className="flex flex-col gap-2">
            <Link
              to="/guilds/$guildId/agents/$agentId/routine"
              params={{ guildId, agentId: agent.id }}
              className="flex w-fit items-center gap-2 rounded-md px-1 py-0.5 hover:bg-surface"
            >
              <Avatar name={agent.name} size={24} {...agentLook(agent)} />
              <span className="font-mono text-sm font-medium">{agent.name}</span>
              <span className="text-xs text-muted">
                {list.length} routine{list.length === 1 ? "" : "s"}
              </span>
            </Link>
            {list.map((routine) => (
              <RoutineRow
                key={routine.id}
                className="bg-surface"
                description={routine.description}
                mode={routine.cron ? "cron" : "window"}
                schedule={timingText(routine)}
                scheduleLabel={routine.label}
                state={stateOf(routine)}
                onSelect={() =>
                  void navigate({
                    to: "/guilds/$guildId/agents/$agentId/routine",
                    params: { guildId, agentId: agent.id },
                  })
                }
                onPausedChange={(pause) =>
                  setPaused.mutate(
                    { agentId: agent.id, scheduleId: routine.id, paused: pause },
                    {
                      onError: (error) =>
                        toast({
                          kind: "error",
                          title: "Couldn't switch the routine",
                          description: error.message,
                        }),
                    },
                  )
                }
                disabled={setPaused.isPending && setPaused.variables.scheduleId === routine.id}
              />
            ))}
          </section>
        ))
      )}
    </GuildPage>
  );
}
