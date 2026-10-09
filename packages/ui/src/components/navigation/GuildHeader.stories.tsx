import type { Meta, StoryObj } from "@storybook/react-vite";
import { Ellipsis } from "lucide-react";
import { IconButton } from "../actions/IconButton";
import type { AvatarStackMember } from "../identity/AvatarStack";
import { GuildHeader } from "./GuildHeader";

const agents: AvatarStackMember[] = [
  { name: "skyzo", tone: "signal" },
  { name: "researchoor", tone: "moss" },
  { name: "managooor", tone: "rosewood" },
  { name: "wallet", tone: "tide" },
];

const about =
  "Degen trading firm. Memecoins and NFTs. Hear it in the trenches, size it, fill it. Moon or get rekt.";

const meta: Meta<typeof GuildHeader> = {
  title: "Components/Navigation/GuildHeader",
  component: GuildHeader,
  args: { name: "Degen-capital", agents, maxAgents: 15, activeCount: 3, about },
  decorators: [
    (Story) => (
      <div className="overflow-hidden rounded-2xl bg-paper pb-16">
        <Story />
      </div>
    ),
  ],
};
export default meta;

type Story = StoryObj<typeof GuildHeader>;

const more = <IconButton icon={Ellipsis} label="Guild options" variant="on-plum" />;

/** Over the group chat. */
export const Full: Story = {
  args: { actions: more },
};

/** Header avatars open that agent. */
export const OpenAgent: Story = {
  args: {
    actions: more,
    onAgentSelect: () => undefined,
  },
};

/** Below the md breakpoint. */
export const Compact: Story = {
  args: { compact: true, activeCount: 0, actions: more },
};

export const CompactActive: Story = {
  args: { compact: true, activeCount: 1, actions: more },
};

/** A private guild whose routines are held; more agents than the stack shows. */
export const PrivateRoutinesOff: Story = {
  args: {
    name: "Link-Prospection",
    visibility: "private",
    routinesEnabled: false,
    activeCount: 0,
    about: "Finds and qualifies leads on LinkedIn, then drafts first messages for review.",
    agents: [
      ...agents,
      { name: "linkedin-researcher", tone: "dusk" },
      { name: "linkedin-messenger", tone: "dusk" },
      { name: "scout", tone: "ochre" },
    ],
    actions: more,
  },
};
