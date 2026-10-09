import type { Meta, StoryObj } from "@storybook/react-vite";
import { ToolChip } from "./ToolChip";

const meta: Meta<typeof ToolChip> = {
  title: "Components/Identity/ToolChip",
  component: ToolChip,
  args: { name: "note_find" },
};
export default meta;

type Story = StoryObj<typeof ToolChip>;

export const Playground: Story = {
  decorators: [
    (Story) => (
      <div className="rounded-xl bg-surface p-6">
        <Story />
      </div>
    ),
  ],
};

export const Tools: Story = {
  render: () => (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap gap-1.5 rounded-xl bg-surface p-6">
        {["note_find", "note_get", "note_write", "record_search", "schedule_list"].map((name) => (
          <ToolChip key={name} name={name} />
        ))}
      </div>
      <div className="flex flex-wrap gap-1.5 rounded-xl bg-paper p-6">
        {["note_find", "note_get", "note_write", "record_search", "schedule_list"].map((name) => (
          <ToolChip key={name} name={name} tone="well" />
        ))}
      </div>
    </div>
  ),
};
