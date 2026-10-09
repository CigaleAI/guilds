import type { Meta, StoryObj } from "@storybook/react-vite";
import { Inbox } from "lucide-react";
import { CornerBadge, Dot, ResultGlyph, RingCount, RingDot } from "./Dot";
import { Icon } from "./Icon";
import { Tile } from "./Tile";

const meta: Meta<typeof Dot> = { title: "Primitives/Dot", component: Dot };
export default meta;

type Story = StoryObj<typeof Dot>;

export const Tones: Story = {
  render: () => (
    <div className="flex flex-col gap-5 rounded-xl bg-surface p-6">
      <div className="flex flex-wrap gap-5">
        {(["signal", "tide", "dusk", "ochre", "plum", "idle"] as const).map((tone) => (
          <span key={tone} className="flex flex-col items-center gap-1.5">
            <Dot tone={tone} />
            <span className="type-meta text-muted">{tone}</span>
          </span>
        ))}
      </div>
      <div className="flex flex-wrap items-center gap-5">
        <CornerBadge badge={<RingDot tone="signal" />}>
          <Tile size={44} tone="well">DC</Tile>
        </CornerBadge>
        <CornerBadge offset="count" badge={<RingCount>10</RingCount>}>
          <Tile size={44} tone="plum">
            <Icon icon={Inbox} size={18} />
          </Tile>
        </CornerBadge>
        <ResultGlyph result="ok" />
        <ResultGlyph result="failed" />
      </div>
    </div>
  ),
};
