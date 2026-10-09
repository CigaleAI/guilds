import type { Meta, StoryObj } from "@storybook/react-vite";
import { Bubble } from "./Bubble";

const meta: Meta<typeof Bubble> = {
  title: "Primitives/Bubble",
  component: Bubble,
  decorators: [
    (Story) => (
      <div className="flex max-w-sm flex-col gap-2.5 rounded-xl bg-surface p-6">
        <Story />
      </div>
    ),
  ],
};
export default meta;

type Story = StoryObj<typeof Bubble>;

export const Variants: Story = {
  render: () => (
    <>
      <Bubble variant="agent">agent · paper</Bubble>
      <Bubble variant="human">human · soft plum · tail corner</Bubble>
      <Bubble variant="trace">trace · ink · mono</Bubble>
    </>
  ),
};
