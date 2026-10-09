import type { Meta, StoryObj } from "@storybook/react-vite";
import type { ReactNode } from "react";
import { Text } from "../../primitives/Text";

const meta: Meta = {
  title: "Components/Blocks/Usage rules",
};
export default meta;

type Story = StoryObj;

function Rule({ swatch, children }: { swatch: ReactNode; children: ReactNode }) {
  return (
    <div className="flex items-start gap-3">
      <span className="flex h-8 w-14 shrink-0 overflow-hidden rounded-sm">{swatch}</span>
      <p className="text-sm text-fg-2">{children}</p>
    </div>
  );
}

export const UsageRules: Story = {
  name: "Usage rules",
  render: () => (
    <div className="flex max-w-lg flex-col gap-4 rounded-xl bg-surface p-6">
      <div className="flex flex-col gap-1">
        <Text variant="title">Feature blocks</Text>
        <Text variant="caption">
          Full‑colour plum + cyan. One per view, for the number or blocker that matters most.
        </Text>
      </div>
      <div className="flex flex-col gap-3">
        <Rule
          swatch={
            <span className="flex flex-1 items-center justify-center bg-plum text-xs font-semibold text-on-plum">
              128
            </span>
          }
        >
          <b className="text-fg">Plum</b> carries the headline: the big number or the blocker. Text
          is always light.
        </Rule>
        <Rule
          swatch={
            <span className="flex flex-1 bg-signal text-2xs text-on-signal">
              <span className="flex flex-1 items-center justify-center">50</span>
              <span className="flex flex-1 items-center justify-center border-l border-on-signal-line">
                9
              </span>
            </span>
          }
        >
          <b className="text-fg">Cyan band</b> carries the breakdown or next action. Text is always
          ink, dividers at 35%.
        </Rule>
        <Rule
          swatch={
            <span className="flex flex-1 items-center justify-center bg-panel text-2xs font-bold text-on-panel">
              LIVE
            </span>
          }
        >
          <b className="text-fg">Ink</b> leads a stack when the item is live.
        </Rule>
        <Rule
          swatch={
            <span className="flex flex-1 rounded-sm border-[1.5px] border-dashed border-rule-2" />
          }
        >
          <b className="text-fg">Don’t</b> put two feature blocks side by side, or use them as
          decoration.
        </Rule>
      </div>
    </div>
  ),
};
