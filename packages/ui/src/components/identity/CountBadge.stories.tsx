import type { Meta, StoryObj } from "@storybook/react-vite";
import { CountBadge } from "./CountBadge";

const meta: Meta<typeof CountBadge> = {
  title: "Components/Identity/CountBadge",
  component: CountBadge,
  args: { children: 26, tone: "plum" },
  decorators: [
    (Story) => (
      <div className="flex flex-wrap items-center gap-3 rounded-xl bg-surface p-6">
        <Story />
      </div>
    ),
  ],
};
export default meta;

type Story = StoryObj<typeof CountBadge>;

export const Playground: Story = {};

export const Tones: Story = {
  render: () => (
    <>
      <CountBadge>26</CountBadge>
      <CountBadge tone="accent">3</CountBadge>
      <CountBadge tone="sand">4</CountBadge>
      <CountBadge tone="ink">112</CountBadge>
    </>
  ),
};
