import type { Meta, StoryObj } from "@storybook/react-vite";
import { StatChip } from "./StatChip";

const meta: Meta<typeof StatChip> = {
  title: "Components/Identity/StatChip",
  component: StatChip,
  args: { children: "24 steps" },
};
export default meta;

type Story = StoryObj<typeof StatChip>;

export const Playground: Story = {
  decorators: [
    (Story) => (
      <div className="rounded-xl bg-surface p-6">
        <Story />
      </div>
    ),
  ],
};

export const RunStats: Story = {
  render: () => (
    <div className="flex flex-col gap-4 rounded-xl bg-surface p-6">
      <div className="flex flex-wrap gap-1.5">
        <StatChip>24 steps</StatChip>
        <StatChip>399k tok</StatChip>
        <StatChip>$0.02</StatChip>
      </div>
      <div className="flex flex-wrap items-center gap-1.5 rounded-lg bg-paper px-3.5 py-2.5">
        <span className="mr-1.5 text-sm font-semibold">Generation 4</span>
        <StatChip tone="well" size="sm">
          2 steps
        </StatChip>
        <StatChip tone="well" size="sm">
          4 calls
        </StatChip>
        <StatChip tone="well" size="sm">
          53k tok
        </StatChip>
        <StatChip tone="well" size="sm">
          $0.11
        </StatChip>
      </div>
    </div>
  ),
};
