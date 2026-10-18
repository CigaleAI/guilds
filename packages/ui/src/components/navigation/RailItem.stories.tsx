import type { Meta, StoryObj } from "@storybook/react-vite";
import { BookOpen, Database, Inbox, Plus, Settings, Sparkles } from "lucide-react";
import { RingCount, RingDot } from "../../primitives/Dot";
import { RailItem } from "./RailItem";

const meta: Meta<typeof RailItem> = {
  title: "Components/Navigation/RailItem",
  component: RailItem,
  args: { label: "Degen-capital", children: "DC", tone: "guild" },
  decorators: [
    (Story) => (
      <div className="flex flex-wrap items-center gap-3 rounded-xl bg-surface p-6">
        <Story />
      </div>
    ),
  ],
};
export default meta;

type Story = StoryObj<typeof RailItem>;

export const Playground: Story = {};

export const Guilds: Story = {
  render: () => (
    <>
      <RailItem label="X-Replies" badge={<RingDot tone="signal" />}>
        XR
      </RailItem>
      <RailItem label="Cigale-Replies-Auto">CR</RailItem>
      <RailItem label="Degen-capital" selected badge={<RingDot tone="signal" />}>
        DC
      </RailItem>
      <RailItem label="Link-Prospection">LP</RailItem>
      <RailItem label="Create guild" tone="add" icon={Plus} />
    </>
  ),
};

export const Tools: Story = {
  render: () => (
    <>
      <RailItem
        label="Inbox"
        tone="plum"
        icon={Inbox}
        badge={<RingCount>26</RingCount>}
        badgeOffset="count"
      />
      <RailItem label="Builder" tone="signal" icon={Sparkles} />
      <RailItem label="Recipes" tone="plum-tint" icon={BookOpen} />
      <RailItem label="Tables" tone="signal-tint" icon={Database} selected />
      <RailItem label="Settings" tone="well" icon={Settings} />
    </>
  ),
};
