import type { Meta, StoryObj } from "@storybook/react-vite";
import { ToggleGroup } from "radix-ui";
import { useState } from "react";
import { AgentChip } from "./AgentChip";

const meta: Meta<typeof AgentChip> = {
  title: "Components/Identity/AgentChip",
  component: AgentChip,
  args: { name: "managooor", tone: "rosewood" },
  decorators: [
    (Story) => (
      <div className="flex flex-wrap gap-2 rounded-xl bg-surface p-6">
        <Story />
      </div>
    ),
  ],
};
export default meta;

type Story = StoryObj<typeof AgentChip>;

export const Playground: Story = {};

export const Chips: Story = {
  render: () => (
    <>
      <AgentChip name="managooor" tone="rosewood" />
      <AgentChip name="wallet" tone="tide" />
      <AgentChip name="scout" tone="signal" />
      <AgentChip name="degen" tone="dusk" />
      <AgentChip name="researchoor" tone="moss" version="v17" />
      <AgentChip name="treasury" tone="ochre" />
    </>
  ),
};

const studioAgents = [
  { name: "managooor", tone: "rosewood", version: "v8" },
  { name: "researchoor", tone: "moss", version: "v17" },
  { name: "skyzo", tone: "signal", version: "v12" },
  { name: "wallet", tone: "tide", version: "v9" },
] as const;

function StudioStrip() {
  const [agent, setAgent] = useState("managooor");
  return (
    <ToggleGroup.Root
      type="single"
      value={agent}
      onValueChange={(next) => next && setAgent(next)}
      aria-label="Agent"
      className="flex flex-wrap items-center gap-1.5"
    >
      {studioAgents.map((a) => (
        <AgentChip
          key={a.name}
          asChild
          variant="strip"
          name={a.name}
          tone={a.tone}
          version={a.version}
        >
          <ToggleGroup.Item value={a.name} />
        </AgentChip>
      ))}
    </ToggleGroup.Root>
  );
}

/** The Studio agent strip: one agent inspected at a time. */
export const Strip: Story = {
  render: () => <StudioStrip />,
};
