import type { Meta, StoryObj } from "@storybook/react-vite";
import { useState } from "react";
import { RoutineRow, type RoutineRowProps } from "./RoutineRow";

const meta: Meta<typeof RoutineRow> = {
  title: "Components/Data/RoutineRow",
  component: RoutineRow,
};
export default meta;

type Story = StoryObj<typeof RoutineRow>;

type Routine = Omit<RoutineRowProps, "selected" | "onSelect" | "onPausedChange"> & { id: string };

const routines: Routine[] = [
  {
    id: "rt_hourly",
    description: "Hourly treasury",
    agentName: "wallet",
    mode: "cron",
    schedule: "0 * * * *",
    scheduleLabel: "Every hour",
    state: { kind: "active", next: "14:00" },
  },
  {
    id: "rt_retro",
    description: "Daily retrospective",
    agentName: "managooor",
    mode: "cron",
    schedule: "0 0 * * 1-5",
    scheduleLabel: "Weekdays at 00:00 UTC",
    state: { kind: "active", next: "Mon 00:00" },
  },
  {
    id: "rt_scout",
    description: "Trench scan",
    agentName: "skyzo",
    mode: "window",
    schedule: "08:00–20:00 · 10× · Europe/Paris",
    scheduleLabel: "Up to 10 random wake-ups between 08:00 and 20:00 every day (Europe/Paris)",
    state: { kind: "active", next: "15:42" },
  },
  {
    id: "rt_watch",
    description: "Watch pass",
    agentName: "researchoor",
    mode: "cron",
    schedule: "*/35 * * * *",
    scheduleLabel: "Every 35 minutes",
    state: { kind: "paused" },
  },
];

function RoutineList({ held = false }: { held?: boolean }) {
  const [selected, setSelected] = useState("rt_retro");
  const [paused, setPaused] = useState<Record<string, boolean>>({ rt_watch: true });
  return (
    <div className="flex max-w-xl flex-col gap-2 rounded-xl bg-surface p-5">
      {routines.map(({ id, ...routine }) => (
        <RoutineRow
          key={id}
          {...routine}
          state={paused[id] ? { kind: "paused" } : held ? { kind: "held" } : routine.state}
          selected={selected === id}
          onSelect={() => setSelected(id)}
          onPausedChange={(next) => setPaused((current) => ({ ...current, [id]: next }))}
        />
      ))}
    </div>
  );
}

export const List: Story = {
  render: () => <RoutineList />,
};

export const HeldByGuild: Story = {
  render: () => <RoutineList held />,
};

export const Narrow: Story = {
  render: () => (
    <div className="flex w-80 flex-col gap-2 rounded-xl bg-surface p-4">
      <RoutineRow
        description="Random scout wake-ups across the trading day"
        agentName="skyzo"
        mode="window"
        schedule="08:00–20:00 · 10× · Europe/Paris"
        state={{ kind: "active", next: "15:42" }}
        onPausedChange={() => {}}
      />
      <RoutineRow
        description="Watch pass"
        agentName="researchoor"
        mode="cron"
        schedule="*/35 * * * *"
        state={{ kind: "paused" }}
        selected
        onPausedChange={() => {}}
      />
    </div>
  ),
};
