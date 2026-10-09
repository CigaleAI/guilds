import type { Meta, StoryObj } from "@storybook/react-vite";
import { MarkSquare } from "../../primitives/Mark";
import { Pill } from "../../primitives/Pill";
import { Tag } from "../../primitives/Tag";
import { Button } from "../actions/Button";
import { Popover, PopoverCloseButton, PopoverContent, PopoverTrigger } from "./Popover";

const meta: Meta<typeof PopoverContent> = {
  title: "Components/Overlays/Popover",
  component: PopoverContent,
};
export default meta;

type Story = StoryObj<typeof PopoverContent>;

function RunMarkPopover({ defaultOpen = false }: { defaultOpen?: boolean }) {
  return (
    <Popover defaultOpen={defaultOpen}>
      <PopoverTrigger asChild>
        <button type="button" aria-label="Run #42, failed" className="flex cursor-pointer rounded-xs">
          <MarkSquare outcome="failed" />
        </button>
      </PopoverTrigger>
      <PopoverContent>
        <div className="flex items-center gap-2">
          <Tag tone="well">#42</Tag>
          <Pill size="xs" fill="plum-tint">
            failed
          </Pill>
          <PopoverCloseButton className="ml-auto" />
        </div>
        <span className="text-md font-semibold">wallet · hourly treasury</span>
        <div className="flex flex-col gap-0.5 text-sm text-fg-2">
          <span>Started by routine at 21:40</span>
          <span>4 steps · 0.9s · $0.003</span>
        </div>
        <div className="flex flex-wrap gap-1.5">
          <Button size="sm">Open step</Button>
          <Button size="sm" variant="outline">
            What woke it
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}

export const WakeMark: Story = {
  render: () => (
    <div className="flex h-72 items-start gap-1 rounded-xl bg-surface p-6">
      <MarkSquare outcome="posted" />
      <MarkSquare outcome="wrote" />
      <MarkSquare outcome="silent" />
      <RunMarkPopover defaultOpen />
      <MarkSquare outcome="posted" />
    </div>
  ),
};

export const ClickToOpen: Story = {
  render: () => (
    <div className="flex items-start gap-1 rounded-xl bg-surface p-6">
      <MarkSquare outcome="posted" />
      <RunMarkPopover />
      <MarkSquare outcome="wrote" />
    </div>
  ),
};
