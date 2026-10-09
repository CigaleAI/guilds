import type { Meta, StoryObj } from "@storybook/react-vite";
import { useState } from "react";
import { OnOffSwitch, type BindingOrigin } from "./OnOffSwitch";

const meta: Meta<typeof OnOffSwitch> = { title: "Components/Controls/OnOffSwitch", component: OnOffSwitch };
export default meta;

type Story = StoryObj<typeof OnOffSwitch>;

function Demo({ initial, origin }: { initial: boolean; origin: BindingOrigin }) {
  const [value, setValue] = useState(initial);
  return <OnOffSwitch label="trend_report" value={value} onValueChange={setValue} origin={origin} />;
}

export const Origins: Story = {
  render: () => (
    <div className="flex flex-wrap justify-between gap-5 rounded-xl bg-surface p-6">
      <Demo initial origin={{ kind: "inherited", from: "guild" }} />
      <Demo initial={false} origin={{ kind: "overridden" }} />
      <Demo initial origin={{ kind: "overridden" }} />
      <OnOffSwitch label="disabled" value onValueChange={() => {}} disabled />
    </div>
  ),
};
