import type { Meta, StoryObj } from "@storybook/react-vite";
import { PromptTag } from "./PromptTag";

const meta: Meta<typeof PromptTag> = {
  title: "Components/Identity/PromptTag",
  component: PromptTag,
  args: { section: "guidelines" },
};
export default meta;

type Story = StoryObj<typeof PromptTag>;

export const Playground: Story = {
  decorators: [
    (Story) => (
      <div className="rounded-xl bg-surface p-6">
        <Story />
      </div>
    ),
  ],
};

export const Sections: Story = {
  render: () => (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap gap-1.5 rounded-xl bg-surface p-6">
        <PromptTag section="guidelines" />
        <PromptTag section="task" />
        <PromptTag section="state" />
        <PromptTag section="memory" />
      </div>
      <div className="flex flex-wrap items-center gap-2 rounded-xl bg-paper p-6">
        <span className="mr-1 text-md font-semibold">System prompt</span>
        <PromptTag section="guidelines" />
        <PromptTag section="task" />
        <PromptTag section="state" />
        <PromptTag section="memory" />
      </div>
    </div>
  ),
};
