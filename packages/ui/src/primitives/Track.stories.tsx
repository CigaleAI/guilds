import type { Meta, StoryObj } from "@storybook/react-vite";
import { useState } from "react";
import { Track, TrackItem } from "./Track";

const meta: Meta<typeof Track> = { title: "Primitives/Track", component: Track };
export default meta;

type Story = StoryObj<typeof Track>;

function Segmented() {
  const [value, setValue] = useState("selected");
  return (
    <Track>
      {["selected", "item", "other"].map((item) => (
        <TrackItem key={item} aria-pressed={value === item} onClick={() => setValue(item)}>
          {item}
        </TrackItem>
      ))}
    </Track>
  );
}

export const Items: Story = {
  render: () => (
    <div className="flex flex-col gap-3 rounded-xl bg-surface p-6">
      <Segmented />
      <div className="flex flex-wrap items-center gap-2">
        <Track size="sm">
          <TrackItem size="sm" selectedFill="accent" quiet aria-pressed>
            On
          </TrackItem>
          <TrackItem size="sm" selectedFill="plum" quiet aria-pressed={false}>
            Off
          </TrackItem>
        </Track>
        <Track size="sm">
          <TrackItem size="sm" selectedFill="accent" quiet aria-pressed={false}>
            On
          </TrackItem>
          <TrackItem size="sm" selectedFill="plum" quiet aria-pressed>
            Off
          </TrackItem>
        </Track>
        <TrackItem disabled>disabled</TrackItem>
      </div>
      <div className="rounded-lg bg-plum p-4">
        <Track tone="on-plum">
          <TrackItem selectedFill="paper" aria-pressed>
            Overview
          </TrackItem>
          <TrackItem className="text-on-plum">Files</TrackItem>
        </Track>
      </div>
    </div>
  ),
};
