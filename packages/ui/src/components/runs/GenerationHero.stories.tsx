import type { Meta, StoryObj } from "@storybook/react-vite";
import { useState } from "react";
import type { GenerationFilter } from "./GenerationFilters";
import { GenerationHero } from "./GenerationHero";
import {
  FlowBatch,
  FlowEntry,
  FlowStepBlock,
  FlowStepRun,
  FlowThought,
  FlowTimeline,
} from "./FlowTimeline";
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
        <FlowEntry marker="steps" tone="failed">
          <FlowStepRun
            steps={2}
            kinds={["read", "write"]}
            effect="wrote"
            failed={1}
            calls={5}
            duration={{ label: "8.8s", title: "8.6s model · 247ms tools" }}
            facts={[{ label: "29k tok" }]}
            open
            onOpenChange={() => {}}
          >
            <FlowTimeline>
              <FlowEntry marker="step" dimmed={dimReads || dimOk}>
                <FlowStepBlock
                  label="Step 1"
                  thinking="I need to create a new schedule every 24 hours. First, I should check the existing ones."
                  kinds={["read"]}
                  calls={3}
                  duration={{ label: "4.2s", title: "4.2s model · 35ms tools" }}
                  facts={[{ label: "14k tok" }]}
                  open
                  onOpenChange={() => {}}
                >
                  <FlowThought
                    label="thinking"
                    summary="I need to create a new schedule every 24 hours. First, I should check the existing ones."
                  />
                  <FlowBatch>
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
                  </FlowBatch>
                </FlowStepBlock>
              </FlowEntry>
              <FlowEntry marker="step" tone="failed">
                <FlowStepBlock
                  label="Step 2"
                  thinking="I need to set a recurring schedule for every 24 hours, considering the user’s retro request."
                  kinds={["write"]}
                  effect="wrote"
                  failed={1}
                  calls={2}
                  duration={{ label: "4.6s", title: "4.4s model · 212ms tools" }}
                  facts={[{ label: "15k tok" }]}
                  open
                  onOpenChange={() => {}}
                >
                  <FlowThought
                    label="thinking"
                    summary="I need to set a recurring schedule for every 24 hours, considering the user’s retro request."
                  />
                  <FlowBatch>
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
                  </FlowBatch>
                </FlowStepBlock>
              </FlowEntry>
            </FlowTimeline>
          </FlowStepRun>
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
