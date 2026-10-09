import type { Meta, StoryObj } from "@storybook/react-vite";
import { StatBand } from "./StatBand";

const meta: Meta<typeof StatBand> = {
  title: "Components/Blocks/StatBand",
  component: StatBand,
  decorators: [
    (Story) => (
      <div className="max-w-3xl overflow-hidden rounded-xl">
        <Story />
      </div>
    ),
  ],
};
export default meta;

type Story = StoryObj<typeof StatBand>;

export const Two: Story = {
  args: {
    stats: [
      { value: "03:00", label: "since" },
      { value: "3 / 3", label: "runs" },
    ],
  },
};

export const Three: Story = {
  args: {
    stats: [
      { value: "03:00", label: "first failure (UTC)" },
      { value: "3 / 3", label: "hourly runs affected" },
      { value: "WALLET_KEY", label: "missing secret" },
    ],
  },
};

export const Four: Story = {
  args: {
    stats: [
      { value: "26", label: "tool calls" },
      { value: "1m 28s", label: "model · 87ms tools" },
      { value: "399k", label: "tokens" },
      { value: "$0.02", label: "cost" },
    ],
  },
};
