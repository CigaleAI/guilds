import type { Meta, StoryObj } from "@storybook/react-vite";
import { useState } from "react";
import type { GenerationFilter } from "./GenerationFilters";
import { GenerationHero } from "./GenerationHero";
import { FlowCallGroup, FlowEntry, FlowThought, FlowTimeline } from "./FlowTimeline";
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
  "ran",
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
      <FlowTimeline>
        <FlowEntry marker="thought" dimmed={dimReads || dimOk}>
          <FlowThought
            label="thinking"
            summary="I need to create a new schedule every 24 hours. First, I should check the existing ones."
            facts={[
              { label: "3 calls", title: "read × 3" },
              { label: "4.2s", title: "4.2s model · 35ms tools" },
              { label: "14k tok" },
            ]}
          />
        </FlowEntry>
        <FlowEntry marker="call" dimmed={dimReads || dimOk}>
          <FlowCallGroup names={["schedule_list", "note_find", "note_find"]} duration="35ms">
            <ToolCall
              index={1}
              name="schedule_list"
              kind="read"
              hint="List schedules"
              status="ok"
              duration="6ms"
              dimmed={dimReads || dimOk}
            />
            <ToolCall
              index={2}
              name="note_find"
              kind="read"
              hint="Find notes…"
              status="ok"
              duration="14ms"
              dimmed={dimReads || dimOk}
            />
            <ToolCall
              index={3}
              name="note_find"
              kind="read"
              hint="Find notes…"
              status="ok"
              duration="15ms"
              dimmed={dimReads || dimOk}
            />
          </FlowCallGroup>
        </FlowEntry>
        <FlowEntry marker="thought">
          <FlowThought
            label="thinking"
            summary="I need to set a recurring schedule for every 24 hours, considering the user’s retro request."
            facts={[
              { label: "2 calls", title: "write × 2" },
              { label: "4.4s", title: "4.4s model · 212ms tools" },
              { label: "15k tok" },
            ]}
          />
        </FlowEntry>
        <FlowEntry marker="call" tone="failed">
          <FlowCallGroup
            names={["schedule_create_cron", "note_write"]}
            failed={1}
            effect="wrote"
            duration="212ms"
            defaultOpen
          >
            <ToolCall
              index={1}
              name="schedule_create_cron"
              kind="write"
              hint="cron 0 0 * * *"
              status="failed"
              error="schedule already exists for this agent"
              duration="190ms"
            />
            <ToolCall
              index={2}
              name="note_write"
              kind="write"
              hint="Wrote retro_template.md"
              effect="wrote"
              status="ok"
              duration="22ms"
              link={<ToolCallLink href="#">retro_template.md</ToolCallLink>}
              dimmed={dimOk}
            />
          </FlowCallGroup>
        </FlowEntry>
      </FlowTimeline>
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
