import type { Meta, StoryObj } from "@storybook/react-vite";
import { useState } from "react";
import type { GenerationFilter } from "./GenerationFilters";
import { GenerationHero } from "./GenerationHero";
import { StepRow } from "./StepRow";
import type { StepOutcome, StepSegment } from "./stepOutcome";
import { ToolCall, ToolCallLink } from "./ToolCall";

const pattern: StepOutcome[] = [
  "ok",
  "wrote",
  "ok",
  "ok",
  "ok",
  "failed",
  "ok",
  "ok",
  "ok",
  "wrote",
  "ok",
  "ok",
];

const steps: StepSegment[] = Array.from({ length: 24 }, (_, index) => ({
  weight: 1 + ((index * 5) % 4),
  outcome: pattern[index % pattern.length] ?? "ok",
  label: `Step ${index + 1}`,
}));

const stats = [
  { value: "26", label: "tool calls" },
  { value: "1m 28s", label: "model · 87ms tools" },
  { value: "399k", label: "tokens" },
  { value: "$0.02", label: "cost" },
];

const meta: Meta<typeof GenerationHero> = {
  title: "Components/Runs/GenerationHero",
  component: GenerationHero,
};
export default meta;

type Story = StoryObj<typeof GenerationHero>;

function Reasoning({ text }: { text: string }) {
  return (
    <div className="border-l-2 border-line py-0.5 pl-3">
      <p className="text-sm whitespace-pre-wrap text-fg-2">{text}</p>
    </div>
  );
}

function Inspector() {
  const [filters, setFilters] = useState<GenerationFilter[]>([]);
  const dimReads = filters.includes("mutations");
  const dimOk = filters.includes("errors");
  return (
    <GenerationHero
      eyebrow="Generation 1 · 24 steps"
      value="21"
      unit="errors"
      steps={steps}
      stats={stats}
      mutations={4}
      failed={21}
      filters={filters}
      onFiltersChange={setFilters}
    >
      <StepRow
        outcome="ok"
        title="Creating a 24‑hour schedule."
        facts={[
          { label: "3 calls", title: "read × 3" },
          { label: "4.2s", title: "4.2s model · 35ms tools" },
          { label: "14k tok" },
        ]}
        filters={filters}
        onFiltersChange={setFilters}
        dimmed={dimReads || dimOk}
        defaultOpen
      >
        <div className="flex flex-col gap-2">
          <Reasoning text="I need to create a new schedule every 24 hours. First, I should check the existing ones." />
          <div className="flex flex-col gap-1.5">
            <ToolCall
              index={1}
              name="schedule_list"
              kind="read"
              level="local"
              hint="List schedules"
              status="ok"
              duration="6ms"
              dimmed={dimReads || dimOk}
            />
            <ToolCall
              index={2}
              name="note_find"
              kind="read"
              level="guild"
              hint="Find notes…"
              status="ok"
              duration="14ms"
              dimmed={dimReads || dimOk}
            />
            <ToolCall
              index={3}
              name="note_find"
              kind="read"
              level="local"
              hint="Find notes…"
              status="ok"
              duration="15ms"
              dimmed={dimReads || dimOk}
            />
          </div>
        </div>
      </StepRow>
      <StepRow
        outcome="failed"
        failed={1}
        title="Creating a schedule for updates."
        facts={[
          { label: "2 calls", title: "write × 2" },
          { label: "4.4s", title: "4.4s model · 212ms tools" },
          { label: "15k tok" },
        ]}
        filters={filters}
        onFiltersChange={setFilters}
        defaultOpen
      >
        <div className="flex flex-col gap-2">
          <Reasoning text="I need to set a recurring schedule for every 24 hours, considering the user’s retro request." />
          <div className="flex flex-col gap-1.5">
            <ToolCall
              index={1}
              name="schedule_create_cron"
              kind="write"
              level="local"
              hint="cron 0 0 * * *"
              status="failed"
              error="schedule already exists for this agent"
              duration="190ms"
            />
            <ToolCall
              index={2}
              name="note_write"
              kind="write"
              level="guild"
              hint="Wrote retro_template.md"
              status="ok"
              duration="22ms"
              link={<ToolCallLink href="#">retro_template.md</ToolCallLink>}
              dimmed={dimOk}
            />
          </div>
        </div>
      </StepRow>
    </GenerationHero>
  );
}

export const AgentInspector: Story = {
  render: () => (
    <div className="max-w-4xl rounded-xl bg-paper p-6">
      <Inspector />
    </div>
  ),
};

export const Completed: Story = {
  render: () => (
    <div className="max-w-4xl rounded-xl bg-paper p-6">
      <GenerationHero
        eyebrow="Generation 4 · 2 steps"
        value="4"
        unit="calls, no errors"
        steps={[
          { weight: 3, outcome: "ok" },
          { weight: 2, outcome: "wrote" },
        ]}
        stats={[
          { value: "4", label: "tool calls" },
          { value: "9.1s", label: "model · 212ms tools" },
          { value: "53k", label: "tokens" },
          { value: "$0.11", label: "cost" },
        ]}
        mutations={1}
        onFiltersChange={() => {}}
      />
    </div>
  ),
};
