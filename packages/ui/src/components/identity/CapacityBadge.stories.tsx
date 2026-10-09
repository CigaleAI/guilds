import type { Meta, StoryObj } from "@storybook/react-vite";
import { CapacityBadge } from "./CapacityBadge";

const meta: Meta<typeof CapacityBadge> = {
  title: "Components/Identity/CapacityBadge",
  component: CapacityBadge,
  args: { count: 4, max: 15, tone: "dusk", size: "md" },
  decorators: [
    (Story) => (
      <div className="flex flex-wrap items-center gap-3 rounded-xl bg-surface p-6">
        <Story />
      </div>
    ),
  ],
};
export default meta;

type Story = StoryObj<typeof CapacityBadge>;

export const Playground: Story = {};

export const Placements: Story = {
  render: () => (
    <>
      <CapacityBadge count={4} max={15} />
      <span className="flex items-center gap-3 rounded-lg bg-plum px-4 py-3 text-lg font-semibold text-on-plum">
        Degen-capital <CapacityBadge count={4} max={15} />
      </span>
      <CapacityBadge count={2} max={15} tone="sand" size="sm" />
      <CapacityBadge count={4} max={15} tone="accent" size="sm" />
      <CapacityBadge count={15} max={15} tone="sand" size="sm" />
    </>
  ),
};
