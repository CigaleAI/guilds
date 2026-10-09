import type { Meta, StoryObj } from "@storybook/react-vite";
import { wakeOutcomeLabel, type WakeOutcome } from "../tones";
import { MarkSquare, OutcomeStrip, SegmentStrip } from "./Mark";

const meta: Meta = { title: "Primitives/Mark" };
export default meta;

type Story = StoryObj;

const outcomes: WakeOutcome[] = ["posted", "wrote", "silent", "failed", "running"];

export const Atoms: Story = {
  render: () => (
    <div className="flex max-w-md flex-col gap-4 rounded-xl bg-surface p-6">
      <div className="flex flex-wrap items-center gap-3.5">
        <MarkSquare outcome="posted" />
        <MarkSquare outcome="silent" />
        <OutcomeStrip className="w-24" counts={{ posted: 43, silent: 7, failed: 1 }} />
        <SegmentStrip
          className="w-24"
          segments={[
            { weight: 3, tone: "signal" },
            { weight: 1, tone: "signal" },
            { weight: 2, tone: "signal" },
            { weight: 1, tone: "plum" },
            { weight: 3, tone: "signal" },
            { weight: 2, tone: "signal" },
          ]}
        />
      </div>
      <div className="grid grid-cols-2 gap-x-3 gap-y-1 text-xs text-fg-2">
        <span><b>square</b> one wake</span>
        <span><b>outcome strip</b> wakes by outcome</span>
        <span><b>segment strip</b> steps</span>
      </div>
    </div>
  ),
};

export const Outcomes: Story = {
  render: () => (
    <div className="flex flex-col gap-2 rounded-xl bg-surface p-6">
      {outcomes.map((outcome) => (
        <div key={outcome} className="flex items-center gap-3 text-sm">
          <MarkSquare outcome={outcome} />
          {wakeOutcomeLabel[outcome]}
        </div>
      ))}
    </div>
  ),
};
