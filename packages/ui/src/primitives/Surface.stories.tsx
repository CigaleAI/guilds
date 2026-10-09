import type { Meta, StoryObj } from "@storybook/react-vite";
import { Surface } from "./Surface";

const meta: Meta<typeof Surface> = {
  title: "Primitives/Surface",
  component: Surface,
  args: { tone: "surface", radius: "xl", children: "surface", className: "p-6" },
};
export default meta;

type Story = StoryObj<typeof Surface>;

export const Playground: Story = {};

export const Nesting: Story = {
  render: () => (
    <div className="flex max-w-md flex-col gap-3">
      <Surface tone="page" radius="xl" className="flex flex-col gap-1.5 p-3">
        <span className="type-meta text-muted">page</span>
        <Surface tone="well" radius="xl" className="flex flex-col gap-1.5 p-3">
          <span className="type-meta text-muted">well</span>
          <Surface tone="surface" radius="lg" className="flex flex-col gap-1.5 p-3">
            <span className="type-meta text-muted">surface</span>
            <Surface tone="paper" radius="md" className="p-3">
              <span className="type-meta text-muted">paper</span>
            </Surface>
          </Surface>
        </Surface>
      </Surface>
      <div className="flex gap-2">
        <Surface tone="panel" radius="lg" className="flex-1 p-2.5 text-2xs">
          ink · emphasis / code
        </Surface>
        <Surface tone="plum" radius="lg" className="flex-1 p-2.5 text-2xs">
          plum · selected / human
        </Surface>
      </div>
    </div>
  ),
};
