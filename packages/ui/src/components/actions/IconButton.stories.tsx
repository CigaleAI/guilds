import type { Meta, StoryObj } from "@storybook/react-vite";
import { ArrowLeft, ArrowUp, Ellipsis, Maximize2, Plus, X } from "lucide-react";
import { IconButton } from "./IconButton";

const meta: Meta<typeof IconButton> = {
  title: "Components/Actions/IconButton",
  component: IconButton,
  args: { icon: Ellipsis, label: "More", variant: "paper", size: 36 },
};
export default meta;

type Story = StoryObj<typeof IconButton>;

export const Playground: Story = {};

export const Variants: Story = {
  render: () => (
    <div className="flex flex-wrap items-center gap-2 rounded-xl bg-surface p-6">
      <IconButton icon={Maximize2} label="Expand" />
      <IconButton icon={Ellipsis} label="More" />
      <IconButton icon={X} label="Close" variant="ink" />
      <IconButton icon={ArrowLeft} label="Back" variant="well" size={44} round />
      <IconButton icon={ArrowUp} label="Send" variant="ink" size={44} />
      <IconButton icon={Plus} label="Add guild" variant="dashed" size={44} />
      <IconButton icon={X} label="Disabled" disabled />
    </div>
  ),
};
