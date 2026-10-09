import type { Meta, StoryObj } from "@storybook/react-vite";
import { useState } from "react";
import type { IdentityTone } from "../../identity";
import { ToneSwatches } from "./ToneSwatches";

const meta: Meta<typeof ToneSwatches> = {
  title: "Components/Controls/ToneSwatches",
  component: ToneSwatches,
};
export default meta;

type Story = StoryObj<typeof ToneSwatches>;

function Demo({ initial, none }: { initial: IdentityTone | undefined; none?: string }) {
  const [tone, setTone] = useState(initial);
  return (
    <div className="flex flex-col gap-3 rounded-xl bg-paper p-6">
      <ToneSwatches
        label="Colour"
        value={tone}
        onValueChange={setTone}
        {...(none ? { none } : {})}
      />
      <span className="type-meta text-muted">{tone ?? "no colour"}</span>
    </div>
  );
}

/** An agent always has one of the six colours. */
export const AgentColour: Story = { render: () => <Demo initial="tide" /> };

/** A person may have none: the first swatch clears it, and their messages stay plum. */
export const PersonColour: Story = {
  render: () => <Demo initial={undefined} none="No colour: plum" />,
};

export const Disabled: Story = {
  render: () => (
    <div className="rounded-xl bg-paper p-6">
      <ToneSwatches label="Colour" value="signal" onValueChange={() => {}} disabled />
    </div>
  ),
};
