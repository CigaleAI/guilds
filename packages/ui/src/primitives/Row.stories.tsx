import type { Meta, StoryObj } from "@storybook/react-vite";
import { ChevronRight, Database } from "lucide-react";
import { Dot } from "./Dot";
import { Icon } from "./Icon";
import { Tag } from "./Tag";
import { Tile } from "./Tile";
import { Track, TrackItem } from "./Track";
import { Row } from "./Row";

const meta: Meta<typeof Row> = {
  title: "Primitives/Row",
  component: Row,
  decorators: [
    (Story) => (
      <div className="flex max-w-md flex-col gap-1.5 rounded-xl bg-surface p-6">
        <Story />
      </div>
    ),
  ],
};
export default meta;

type Story = StoryObj<typeof Row>;

export const LeadBodyTrail: Story = {
  render: () => (
    <Row
      tone="paper"
      mono
      lead={<Tile size={28} tone="tide">WA</Tile>}
      title="wallet"
      meta="Active via guild"
      trail={
        <Track size="sm">
          <TrackItem size="sm" selectedFill="accent" quiet aria-pressed>
            On
          </TrackItem>
          <TrackItem size="sm" selectedFill="plum" quiet aria-pressed={false}>
            Off
          </TrackItem>
        </Track>
      }
    />
  ),
};

export const States: Story = {
  render: () => (
    <>
      <Row asChild interactive lead={<Dot tone="signal" />} title="skyzo" mono trail={<Tag tone="signal">running</Tag>}>
        <button type="button" />
      </Row>
      <Row asChild interactive selected lead={<Icon icon={Database} />} title="degen-meta" meta="Tracking web3 & crypto meta" trail={<Icon icon={ChevronRight} />}>
        <button type="button" />
      </Row>
      <Row danger title="row · danger" />
      <Row disabled title="row · disabled" />
    </>
  ),
};
