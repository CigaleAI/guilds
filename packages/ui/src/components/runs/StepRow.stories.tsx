import type { Meta, StoryObj } from "@storybook/react-vite";
import { CallBatch } from "./CallBatch";
import { StepRow } from "./StepRow";
import { ToolCall } from "./ToolCall";

const meta: Meta<typeof StepRow> = {
  title: "Components/Runs/StepRow",
  component: StepRow,
  args: {
    step: 1,
    outcome: "ok",
    title: "Creating a 24‑hour schedule.",
    detail: "First, check the existing ones.",
    duration: "4.2s",
    tokens: "14k tok",
  },
};
export default meta;

type Story = StoryObj<typeof StepRow>;

export const Playground: Story = {
  render: (args) => (
    <div className="rounded-xl bg-surface p-6">
      <StepRow {...args} />
    </div>
  ),
};

export const CollapsedAndOpen: Story = {
  render: () => (
    <div className="flex flex-col gap-3 rounded-xl bg-surface p-6">
      <StepRow
        step={1}
        outcome="ok"
        title="Creating a 24‑hour schedule."
        detail="First, check the existing ones."
        duration="4.2s"
        tokens="14k tok"
        defaultOpen
      >
        <CallBatch count={2} duration="20ms">
          <ToolCall
            index={1}
            name="schedule_list"
            kind="read"
            level="local"
            hint="List schedules"
            status="ok"
            duration="6ms"
            onClick={() => {}}
          />
          <ToolCall
            index={2}
            name="note_find"
            kind="read"
            level="guild"
            hint="Find notes…"
            status="ok"
            duration="14ms"
            expanded
            detail={
              <div className="max-h-36 overflow-auto rounded-md bg-surface p-3">
                <p className="font-mono text-xs text-fg">query: treasury notes</p>
              </div>
            }
            onClick={() => {}}
          />
        </CallBatch>
      </StepRow>
      <StepRow
        step={2}
        outcome="failed"
        title="Creating a schedule."
        detail="Set a recurring 24h schedule."
        duration="4.4s"
        tokens="15k tok"
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
    </div>
  ),
};

export const States: Story = {
  render: () => (
    <div className="flex flex-col gap-3 rounded-xl bg-surface p-6">
      <StepRow
        step={3}
        outcome="wrote"
        title="Recording the retro."
        detail="Write the learnings into the fund thesis note and memory."
        duration="3.1s"
        tokens="12k tok"
      >
        <ToolCall
          name="note_write"
          kind="write"
          level="guild"
          hint="fund_thesis.md"
          status="ok"
          duration="22ms"
        />
      </StepRow>
      <StepRow
        step={4}
        outcome="ok"
        title="Summarising."
        detail="The retrospective ran long; the answer was cut at the budget."
        duration="9.8s"
        tokens="32k tok"
        hitMaxTokens
      />
      <StepRow
        step={5}
        outcome="running"
        title="Posting to the guild."
        detail="Waiting for group_post."
        duration="2.2s"
      />
      <StepRow step={null} outcome="ok" detail="Tool result with no requesting step" dimmed />
    </div>
  ),
};
