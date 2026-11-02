import type { Meta, StoryObj } from "@storybook/react-vite";
import { ModeTag } from "./ModeTag";

const meta: Meta<typeof ModeTag> = {
  title: "Components/Identity/ModeTag",
  component: ModeTag,
  args: { mode: "write" },
  decorators: [
    (Story) => (
      <div className="flex flex-wrap items-center gap-2 rounded-xl bg-surface p-6">
        <Story />
      </div>
    ),
  ],
};
export default meta;

type Story = StoryObj<typeof ModeTag>;

export const Playground: Story = {};

export const AgentModes: Story = {
  render: () => (
    <>
      <ModeTag mode="write" />
      <ModeTag mode="read" />
      <ModeTag mode="none" />
    </>
  ),
};

export const GuildModes: Story = {
  render: () => (
    <>
      <ModeTag mode="all_write" />
      <ModeTag mode="all_read" />
      <ModeTag mode="some" />
      <ModeTag mode="none" />
    </>
  ),
};

export const OnPaper: Story = {
  render: () => (
    <div className="flex flex-wrap items-center gap-2 rounded-lg bg-paper p-4">
      <ModeTag mode="write" />
      <ModeTag mode="all_read" />
      <ModeTag mode="some" />
      <ModeTag mode="none" />
    </div>
  ),
};
