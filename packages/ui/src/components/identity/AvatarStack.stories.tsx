import type { Meta, StoryObj } from "@storybook/react-vite";
import { AvatarStack, type AvatarStackMember } from "./AvatarStack";

const degenCapital: AvatarStackMember[] = [
  { name: "skyzo", tone: "signal" },
  { name: "wallet", tone: "tide" },
  { name: "managooor", tone: "rosewood" },
  { name: "degen", tone: "dusk" },
];

const meta: Meta<typeof AvatarStack> = {
  title: "Components/Identity/AvatarStack",
  component: AvatarStack,
  args: { members: degenCapital, ring: "surface", size: 36 },
};
export default meta;

type Story = StoryObj<typeof AvatarStack>;

export const Playground: Story = {
  decorators: [
    (Story) => (
      <div className="rounded-xl bg-surface p-6">
        <Story />
      </div>
    ),
  ],
};

/** On the plum guild header; a plum agent flips to surface so it does not vanish into the band. */
export const OnPlum: Story = {
  render: () => (
    <div className="flex flex-col gap-4 rounded-xl bg-surface p-6">
      <div className="flex self-start rounded-lg bg-plum p-4">
        <AvatarStack members={degenCapital} ring="plum" size={44} />
      </div>
      <div className="flex self-start rounded-lg bg-plum p-4">
        <AvatarStack members={degenCapital} ring="plum" size={36} caption="4 of 15 seats" />
      </div>
    </div>
  ),
};

export const Rings: Story = {
  render: () => (
    <div className="flex flex-col gap-4 rounded-xl bg-surface p-6">
      <AvatarStack members={degenCapital} ring="surface" caption="4 of 15 seats" />
      <div className="self-start rounded-lg bg-paper p-4">
        <AvatarStack members={degenCapital} ring="paper" size={44} caption="4 of 15 seats" />
      </div>
    </div>
  ),
};

const fullGuild: AvatarStackMember[] = [
  ...degenCapital,
  { name: "researchoor", tone: "moss" },
  { name: "scout", tone: "dusk" },
  { name: "treasury", tone: "ochre" },
  { name: "Emma Martin", tone: "signal", round: true },
];

/** Each tile is a button. */
export const OpenMember: Story = {
  args: {
    onMemberSelect: () => undefined,
  },
  decorators: [
    (Story) => (
      <div className="rounded-xl bg-surface p-6">
        <Story />
      </div>
    ),
  ],
};

export const Overflow: Story = {
  render: () => (
    <div className="flex flex-col gap-4 rounded-xl bg-surface p-6">
      <div className="flex self-start rounded-lg bg-plum p-4">
        <AvatarStack members={fullGuild} ring="plum" size={44} max={5} />
      </div>
      <AvatarStack members={fullGuild} ring="surface" max={3} caption="8 of 15 seats" />
    </div>
  ),
};
