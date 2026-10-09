import type { Meta, StoryObj } from "@storybook/react-vite";
import { Database } from "lucide-react";
import { Icon } from "./Icon";
import { Tile } from "./Tile";

const meta: Meta<typeof Tile> = {
  title: "Primitives/Tile",
  component: Tile,
  args: { size: 44, tone: "tide", children: "WA" },
};
export default meta;

type Story = StoryObj<typeof Tile>;

export const Playground: Story = {};

export const Sizes: Story = {
  render: () => (
    <div className="flex flex-wrap items-end gap-3 rounded-xl bg-surface p-6">
      <Tile size={24} tone="signal">EM</Tile>
      <Tile size={28} tone="plum">MG</Tile>
      <Tile size={32} tone="dusk">DG</Tile>
      <Tile size={36} tone="signal-tint">
        <Icon icon={Database} />
      </Tile>
      <Tile size={44} tone="tide">WA</Tile>
      <Tile size={64} tone="dusk">RS</Tile>
    </div>
  ),
};

const tones = [
  "signal",
  "signal-2",
  "tide",
  "dusk",
  "plum",
  "mauve",
  "ochre",
  "ink",
  "paper",
  "well",
  "signal-tint",
  "tide-tint",
  "plum-tint",
  "outline",
  "dashed",
] as const;

export const Tones: Story = {
  render: () => (
    <div className="flex flex-wrap gap-2 rounded-xl bg-surface p-6">
      {tones.map((tone) => (
        <Tile key={tone} size={36} tone={tone} title={tone}>
          AB
        </Tile>
      ))}
    </div>
  ),
};
