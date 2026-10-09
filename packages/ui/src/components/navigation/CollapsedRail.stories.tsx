import type { Meta, StoryObj } from "@storybook/react-vite";
import { BookOpen, Database, Inbox, Settings, Sparkles } from "lucide-react";
import { useState } from "react";
import { RingCount, RingDot } from "../../primitives/Dot";
import { Avatar } from "../identity/Avatar";
import { CollapsedRail } from "./CollapsedRail";
import { RailItem } from "./RailItem";

const meta: Meta<typeof CollapsedRail> = {
  title: "Components/Navigation/CollapsedRail",
  component: CollapsedRail,
  parameters: { layout: "fullscreen" },
};
export default meta;

type Story = StoryObj<typeof CollapsedRail>;

const guilds = [
  { name: "X-Replies", initials: "XR", active: true },
  { name: "Cigale-Replies-Auto", initials: "CR", active: false },
  { name: "Degen-capital", initials: "DC", active: true },
  { name: "Link-Prospection", initials: "LP", active: false },
];

function RailDemo() {
  const [selected, setSelected] = useState("Degen-capital");
  return (
    <CollapsedRail
      onExpand={() => {}}
      onCreateGuild={() => {}}
      guilds={guilds.map((guild) => (
        <RailItem
          key={guild.name}
          label={guild.name}
          selected={guild.name === selected}
          onClick={() => setSelected(guild.name)}
          {...(guild.active ? { badge: <RingDot tone="signal" /> } : {})}
        >
          {guild.initials}
        </RailItem>
      ))}
      tools={
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
          <RailItem label="Databases" tone="signal-tint" icon={Database} />
        </>
      }
      footer={
        <>
          <RailItem label="Settings" tone="well" icon={Settings} />
          <button type="button" aria-label="Account" className="cursor-pointer rounded-full">
            <Avatar name="Emma Martin" initials="EM" tone="dusk" size={36} round />
          </button>
        </>
      }
    />
  );
}

export const Default: Story = {
  render: () => (
    <div className="flex h-200 bg-well p-4">
      <RailDemo />
    </div>
  ),
};

/** Many guilds: the guild tiles scroll, tools and account stay put. */
export const ManyGuilds: Story = {
  render: () => (
    <div className="flex h-150 bg-well p-4">
      <CollapsedRail
        onExpand={() => {}}
        onCreateGuild={() => {}}
        guilds={["XR", "CR", "DC", "LP", "AR", "OP", "TR", "MX"].map((initials, index) => (
          <RailItem key={initials} label={`Guild ${initials}`} selected={index === 2}>
            {initials}
          </RailItem>
        ))}
        tools={<RailItem label="Inbox" tone="plum" icon={Inbox} />}
        footer={<RailItem label="Settings" tone="well" icon={Settings} />}
      />
    </div>
  ),
};
