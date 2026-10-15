import type { Meta, StoryObj } from "@storybook/react-vite";
import { AgentRow } from "./AgentRow";

const meta: Meta<typeof AgentRow> = {
  title: "Components/Navigation/AgentRow",
  component: AgentRow,
  args: { name: "skyzo", tone: "signal", state: "running" },
  decorators: [
    (Story) => (
      <div className="flex w-68 flex-col gap-0.5 rounded-xl bg-surface p-4">
        <Story />
      </div>
    ),
  ],
};
export default meta;

type Story = StoryObj<typeof AgentRow>;

export const Playground: Story = {};

export const States: Story = {
  render: () => (
    <>
      <AgentRow name="skyzo" tone="signal" state="running" />
      <AgentRow name="researchoor" tone="moss" state="idle" browser />
      <AgentRow name="wallet" tone="tide" state="idle" selected />
      <AgentRow name="builder" tone="dusk" state="idle" coding />
      <AgentRow name="managooor" tone="rosewood" state="connecting" />
      <AgentRow name="linkedin-researcher" tone="dusk" state="idle" browser />
      <AgentRow name="treasury" tone="ochre" state="idle" brokenLinks={["notes/desk.md"]} />
    </>
  ),
};

/** As a link to the agent's route. */
export const AsLink: Story = {
  render: () => (
    <AgentRow asChild name="managooor" tone="rosewood" state="idle">
      <a href="#managooor" />
    </AgentRow>
  ),
};
