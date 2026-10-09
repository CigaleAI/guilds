import type { Meta, StoryObj } from "@storybook/react-vite";
import { HighlightBadge } from "./HighlightBadge";

const meta: Meta<typeof HighlightBadge> = {
  title: "Components/Identity/HighlightBadge",
  component: HighlightBadge,
  args: { children: "54 available" },
  decorators: [
    (Story) => (
      <div className="flex flex-wrap items-center gap-3 rounded-xl bg-surface p-6">
        <Story />
      </div>
    ),
  ],
};
export default meta;

type Story = StoryObj<typeof HighlightBadge>;

export const Playground: Story = {};

export const Sizes: Story = {
  render: () => (
    <>
      <HighlightBadge>54 available</HighlightBadge>
      <span className="flex items-center gap-2 rounded-full bg-paper py-2 pr-2 pl-4 text-sm font-semibold">
        Offered tools <HighlightBadge size="sm">54 available</HighlightBadge>
      </span>
      <HighlightBadge size="sm">$2.59 spent</HighlightBadge>
    </>
  ),
};
