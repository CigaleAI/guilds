import type { Meta, StoryObj } from "@storybook/react-vite";
import { DashedGroup, Divider, LabelledDivider, TreeRail } from "./Divider";
import { Kbd } from "./Kbd";

const meta: Meta<typeof Divider> = { title: "Primitives/Divider and Kbd", component: Divider };
export default meta;

type Story = StoryObj<typeof Divider>;

export const All: Story = {
  render: () => (
    <div className="flex max-w-sm flex-col gap-3 rounded-xl bg-surface p-6">
      <Divider />
      <LabelledDivider label="Routine · hourly treasury · 03:00 UTC" />
      <DashedGroup className="text-xs text-muted">dashed group · parallel / pending</DashedGroup>
      <TreeRail className="text-xs text-muted">tree rail · nesting</TreeRail>
      <div className="flex items-center gap-1.5">
        <Kbd>↵ Enter</Kbd>
        <Kbd>⇧</Kbd>
        <Kbd>⌘K</Kbd>
      </div>
    </div>
  ),
};
