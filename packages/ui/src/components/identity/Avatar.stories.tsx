import type { Meta, StoryObj } from "@storybook/react-vite";
import { identityTones } from "../../identity";
import { Avatar } from "./Avatar";

const meta: Meta<typeof Avatar> = {
  title: "Components/Identity/Avatar",
  component: Avatar,
  args: { name: "managooor", tone: "rosewood", size: 44 },
};
export default meta;

type Story = StoryObj<typeof Avatar>;

export const Playground: Story = {};

export const Sizes: Story = {
  render: () => (
    <div className="flex flex-wrap items-end gap-3 rounded-xl bg-surface p-6">
      <Avatar name="managooor" tone="rosewood" size={64} />
      <Avatar name="wallet" tone="tide" size={44} />
      <Avatar name="skyzo" tone="signal" size={44} />
      <Avatar name="degen" tone="dusk" size={44} />
      <Avatar name="researchoor" tone="moss" size={28} />
      <Avatar name="Emma Martin" initials="EM" tone="signal" size={28} round />
    </div>
  ),
};

export const IdentityPalette: Story = {
  render: () => (
    <div className="flex flex-wrap gap-2 rounded-xl bg-surface p-6">
      {identityTones.map((tone) => (
        <Avatar key={tone} name={tone} tone={tone} size={36} />
      ))}
    </div>
  ),
};
