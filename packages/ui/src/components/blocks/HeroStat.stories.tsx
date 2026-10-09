import type { Meta, StoryObj } from "@storybook/react-vite";
import { HeroStat } from "./HeroStat";

const meta: Meta<typeof HeroStat> = {
  title: "Components/Blocks/HeroStat",
  component: HeroStat,
  decorators: [
    (Story) => (
      <div className="max-w-3xl rounded-xl bg-surface p-6">
        <Story />
      </div>
    ),
  ],
};
export default meta;

type Story = StoryObj<typeof HeroStat>;

export const StudioWakes: Story = {
  args: {
    value: "128",
    unit: "wakes · last 24h",
    accent: "$2.59 spent",
    segments: [
      { weight: 50, tone: "signal", label: "50 posted" },
      { weight: 6, tone: "signal-2", label: "6 wrote records" },
      { weight: 63, tone: "on-plum-track", label: "63 no output" },
      { weight: 9, tone: "plum-soft", label: "9 failed" },
    ],
    stats: [
      { value: "50", label: "posted" },
      { value: "6", label: "wrote records" },
      { value: "63", label: "no output" },
      { value: "9", label: "failed" },
    ],
  },
};

export const UsageBudget: Story = {
  args: {
    label: "September · Organisation",
    value: "$41.20",
    unit: "of $60 monthly limit",
    accent: "68% used",
    progress: 0.68,
    stats: [
      { value: "1,284", label: "wakes" },
      { value: "9.8M", label: "tokens" },
      { value: "$0.032", label: "per wake" },
      { value: "$18.80", label: "left this month" },
    ],
  },
};

export const Narrow: Story = {
  decorators: [
    (Story) => (
      <div className="max-w-xs">
        <Story />
      </div>
    ),
  ],
  args: {
    label: "Last 24h",
    value: "128",
    unit: "wakes",
    segments: [
      { weight: 5, tone: "signal" },
      { weight: 1, tone: "signal-2" },
      { weight: 6, tone: "on-plum-track" },
      { weight: 1, tone: "plum-soft" },
    ],
    stats: [
      { value: "50", label: "posted" },
      { value: "63", label: "idle" },
      { value: "9", label: "failed" },
    ],
  },
};
