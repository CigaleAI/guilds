import type { Meta, StoryObj } from "@storybook/react-vite";
import { Tag } from "./Tag";

const meta: Meta<typeof Tag> = {
  title: "Primitives/Tag",
  component: Tag,
  args: { tone: "paper", children: "portfolio_valuation.md" },
};
export default meta;

type Story = StoryObj<typeof Tag>;

export const Playground: Story = {};

export const Tones: Story = {
  render: () => (
    <div className="flex max-w-sm flex-wrap gap-1.5 rounded-xl bg-surface p-6">
      <Tag tone="paper">mono · paper</Tag>
      <Tag tone="well">mono · well</Tag>
      <Tag tone="term">term</Tag>
      <Tag tone="ink">ink</Tag>
      <Tag tone="signal">&lt;guidelines&gt;</Tag>
      <Tag tone="plum">&lt;task&gt;</Tag>
      <Tag tone="tide">&lt;state&gt;</Tag>
      <Tag tone="ochre">&lt;memory&gt;</Tag>
      <Tag tone="plum" font="sans">
        @managooor
      </Tag>
    </div>
  ),
};
