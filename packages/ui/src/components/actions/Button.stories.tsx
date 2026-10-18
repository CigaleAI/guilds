import type { Meta, StoryObj } from "@storybook/react-vite";
import { Plus } from "lucide-react";
import { Icon } from "../../primitives/Icon";
import { Button } from "./Button";

const meta: Meta<typeof Button> = {
  title: "Components/Actions/Button",
  component: Button,
  args: { variant: "primary", size: "md", children: "Run workflow" },
};
export default meta;

type Story = StoryObj<typeof Button>;

export const Playground: Story = {};

export const Variants: Story = {
  render: () => (
    <div className="flex flex-col gap-3 rounded-xl bg-surface p-6">
      <div className="flex flex-wrap items-center gap-2.5">
        <Button size="lg">Run workflow</Button>
        <Button size="lg" variant="accent">Deploy</Button>
        <Button size="lg" variant="outline">Last 30 days</Button>
        <Button size="lg" variant="ghost">Cancel</Button>
        <Button size="lg" disabled>Publish</Button>
      </div>
      <div className="flex flex-wrap items-center gap-2.5">
        <Button variant="secondary">3/3 tools</Button>
        <Button variant="danger">Remove</Button>
        <Button variant="destructive">Delete table</Button>
        <Button>
          <Icon icon={Plus} size={14} />
          New routine
        </Button>
      </div>
      <div className="flex flex-wrap items-center gap-2.5 rounded-lg bg-plum p-4">
        <Button variant="on-plum" size="sm">Investigate</Button>
        <Button variant="accent" size="sm">Add secret →</Button>
      </div>
      <div className="flex flex-wrap items-center gap-2.5 rounded-lg bg-panel p-4">
        <Button variant="on-panel" size="sm">Back to guild</Button>
        <Button variant="on-panel" size="sm">
          <Icon icon={Plus} size={14} />
          New session
        </Button>
      </div>
    </div>
  ),
};

export const Sizes: Story = {
  render: () => (
    <div className="flex flex-wrap items-center gap-2.5 rounded-xl bg-surface p-6">
      {(["xs", "sm", "md", "lg", "xl", "2xl"] as const).map((size) => (
        <Button key={size} size={size}>
          {size}
        </Button>
      ))}
    </div>
  ),
};
