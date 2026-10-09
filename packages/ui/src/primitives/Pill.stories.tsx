import type { Meta, StoryObj } from "@storybook/react-vite";
import { Play } from "lucide-react";
import { Dot } from "./Dot";
import { Icon } from "./Icon";
import { Pill, PillCount } from "./Pill";

const meta: Meta<typeof Pill> = {
  title: "Primitives/Pill",
  component: Pill,
  args: { size: "sm", fill: "ink", children: "Pill" },
};
export default meta;

type Story = StoryObj<typeof Pill>;

export const Playground: Story = {};

const fills = [
  "ink",
  "accent",
  "plum",
  "signal-tint",
  "tide-tint",
  "plum-tint",
  "ochre-tint",
  "sand",
  "paper",
  "outline",
  "danger",
  "ghost",
  "disabled",
] as const;

export const SizeAndFill: Story = {
  render: () => (
    <div className="flex flex-col gap-4 rounded-xl bg-surface p-6">
      <div className="flex flex-wrap items-center gap-2">
        {(["xs", "sm", "md", "lg", "xl"] as const).map((size) => (
          <Pill key={size} size={size}>
            {size}
          </Pill>
        ))}
      </div>
      <div className="flex flex-wrap gap-1.5">
        {fills.map((fill) => (
          <Pill key={fill} fill={fill}>
            {fill}
          </Pill>
        ))}
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
        <Pill size="md">
          <Icon icon={Play} size={14} />
          With icon
        </Pill>
        <Pill size="md" fill="signal-tint">
          <Dot size="sm" tone="signal" />
          With dot
        </Pill>
        <Pill size="md" fill="ghost">
          With count <PillCount>26</PillCount>
        </Pill>
      </div>
    </div>
  ),
};
