import type { Meta, StoryObj } from "@storybook/react-vite";
import { TypingIndicator } from "./TypingIndicator";

const meta: Meta<typeof TypingIndicator> = {
  title: "Components/Conversation/TypingIndicator",
  component: TypingIndicator,
  args: { name: "scout", tone: "signal", avatarSize: 32, bubble: "paper" },
};
export default meta;

type Story = StoryObj<typeof TypingIndicator>;

export const Playground: Story = {
  render: (args) => (
    <div className="rounded-xl bg-surface p-6">
      <TypingIndicator {...args} />
    </div>
  ),
};

export const InGroupChat: Story = {
  render: () => (
    <div className="flex flex-col gap-4 rounded-xl bg-paper p-6">
      <TypingIndicator
        name="skyzo"
        tone="signal"
        bubble="surface"
        caption="skyzo is scanning the trenches…"
      />
      <TypingIndicator
        name="researchoor"
        tone="tide"
        bubble="surface"
        caption="researchoor is responding… (2 waiting messages)"
      />
    </div>
  ),
};
