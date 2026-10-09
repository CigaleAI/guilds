import type { Meta, StoryObj } from "@storybook/react-vite";
import { Search, Settings } from "lucide-react";
import { MarkSquare } from "../../primitives/Mark";
import { IconButton } from "../actions/IconButton";
import { Tooltip, TooltipProvider } from "./Tooltip";

const meta: Meta<typeof Tooltip> = {
  title: "Components/Overlays/Tooltip",
  component: Tooltip,
  decorators: [
    (Story) => (
      <TooltipProvider>
        <Story />
      </TooltipProvider>
    ),
  ],
};
export default meta;

type Story = StoryObj<typeof Tooltip>;

export const Open: Story = {
  render: () => (
    <div className="flex items-center justify-around rounded-xl bg-surface px-6 pt-16 pb-24">
      <Tooltip label="#42 · wallet · failed · 21:40" mono defaultOpen>
        <button type="button" aria-label="Run #42" className="flex cursor-pointer rounded-xs">
          <MarkSquare outcome="failed" />
        </button>
      </Tooltip>
      <Tooltip label="Search" shortcut="⌘K" defaultOpen>
        <IconButton icon={Search} label="Search" variant="ghost" />
      </Tooltip>
      <Tooltip
        label="Tools, secrets and seats for every agent in Degen-capital. Agents inherit these unless they override."
        side="bottom"
        defaultOpen
      >
        <IconButton icon={Settings} label="Guild settings" variant="ghost" />
      </Tooltip>
    </div>
  ),
};

export const OnHover: Story = {
  render: () => (
    <div className="flex items-center gap-3 rounded-xl bg-surface p-6">
      <Tooltip label="Search" shortcut="⌘K">
        <IconButton icon={Search} label="Search" variant="paper" />
      </Tooltip>
      <Tooltip label="#43 · wallet · posted · 22:40" mono>
        <button type="button" aria-label="Run #43" className="flex cursor-pointer rounded-xs">
          <MarkSquare outcome="posted" />
        </button>
      </Tooltip>
    </div>
  ),
};
