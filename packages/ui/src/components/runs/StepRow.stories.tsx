import type { Meta, StoryObj } from "@storybook/react-vite";
import { useState } from "react";
import { CopyButton } from "../actions/CopyButton";
import type { GenerationFilter } from "./GenerationFilters";
import { StepRow } from "./StepRow";
import { ToolCall, ToolCallLink, mutatingKinds } from "./ToolCall";

const facts = [
  { label: "2 calls", title: "read × 2" },
  { label: "4.2s", title: "4.2s model · 20ms tools" },
  { label: "14k tok", title: "13,620 in · 380 out" },
  { label: "$0.0041", title: "Cost source: catalog" },
];

const reasoning =
  "I need to create a new schedule every 24 hours. First, I should check the existing ones so I do not create a duplicate, and look for the retro template the guild keeps.";

const meta: Meta<typeof StepRow> = {
  title: "Components/Runs/StepRow",
  component: StepRow,
  args: {
    outcome: "ok",
    title: "Creating a 24‑hour schedule.",
    facts,
  },
};
export default meta;

type Story = StoryObj<typeof StepRow>;

/** How the app lays a step's reasoning out above its calls. */
function Reasoning({ text }: { text: string }) {
  return (
    <div className="relative border-l-2 border-line py-0.5 pr-9 pl-3">
      <p className="text-sm whitespace-pre-wrap text-fg-2">{text}</p>
      <CopyButton text={text} what="reasoning" size={24} className="absolute top-0 right-0" />
    </div>
  );
}

export const Playground: Story = {
  render: (args) => (
    <div className="rounded-xl bg-surface p-6">
      <StepRow {...args} />
    </div>
  ),
};

function Filtered() {
  const [filters, setFilters] = useState<GenerationFilter[]>([]);
  const dim = (kind: "read" | "write") =>
    filters.includes("mutations") && !mutatingKinds.has(kind);
  return (
    <div className="flex flex-col gap-1.5 rounded-xl bg-surface p-6">
      <StepRow
        outcome="ok"
        title="Creating a 24‑hour schedule."
        facts={facts}
        filters={filters}
        onFiltersChange={setFilters}
        dimmed={dim("read")}
        defaultOpen
      >
        <div className="flex flex-col gap-2">
          <Reasoning text={reasoning} />
          <div className="flex flex-col gap-1.5">
            <ToolCall
              index={1}
              name="schedule_list"
              kind="read"
              level="local"
              hint="List schedules"
              status="ok"
              duration="6ms"
              dimmed={dim("read")}
              onClick={() => {}}
            />
            <ToolCall
              index={2}
              name="note_find"
              kind="read"
              level="guild"
              hint="Find notes retro"
              status="ok"
              duration="14ms"
              dimmed={dim("read")}
              onClick={() => {}}
            />
          </div>
        </div>
      </StepRow>
      <StepRow
        outcome="wrote"
        title="Recording the retro."
        facts={[
          { label: "1 call", title: "write" },
          { label: "3.1s" },
          { label: "12k tok" },
          { label: "$0.0036" },
        ]}
        filters={filters}
        onFiltersChange={setFilters}
        defaultOpen
      >
        <div className="flex flex-col gap-2">
          <Reasoning text="The retro is done; I will write the learnings into the fund thesis note." />
          <ToolCall
            name="note_write"
            kind="write"
            level="guild"
            hint="Wrote fund_thesis.md"
            status="ok"
            duration="22ms"
            link={<ToolCallLink href="#">fund_thesis.md</ToolCallLink>}
            onClick={() => {}}
          />
        </div>
      </StepRow>
    </div>
  );
}

/** Press **wrote** to keep only the calls that changed state. */
export const ReasoningThenCalls: Story = {
  render: () => <Filtered />,
};

export const States: Story = {
  render: () => (
    <div className="flex flex-col gap-1.5 rounded-xl bg-surface p-6">
      <StepRow
        outcome="failed"
        failed={1}
        title="Creating a schedule."
        facts={[{ label: "1 call", title: "write" }, { label: "4.4s" }, { label: "15k tok" }]}
      >
        <ToolCall
          name="schedule_create_cron"
          kind="write"
          level="local"
          hint="cron 0 0 * * *"
          status="failed"
          error="schedule already exists for this agent"
          duration="190ms"
        />
      </StepRow>
      <StepRow
        outcome="failed"
        failed={2}
        title="Retrying both writes."
        facts={[{ label: "2 calls", title: "write × 2" }, { label: "2.9s" }, { label: "9k tok" }]}
        filters={["errors"]}
        onFiltersChange={() => {}}
      />
      <StepRow
        outcome="ok"
        title="Summarising."
        facts={[{ label: "9.8s" }, { label: "32k tok" }]}
        stop="max tokens"
      />
      <StepRow outcome="running" title="Posting to the guild." facts={[{ label: "1 call" }]} />
      <StepRow outcome="ok" title="group_post, memory_write" dimmed />
    </div>
  ),
};
