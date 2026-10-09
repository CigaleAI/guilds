import type { Meta, StoryObj } from "@storybook/react-vite";
import { AgentRow } from "./AgentRow";
import { GuildRow } from "./GuildRow";

const meta: Meta<typeof GuildRow> = {
  title: "Components/Navigation/GuildRow",
  component: GuildRow,
  args: { name: "Degen-capital", agentCount: 4, maxAgents: 15 },
  decorators: [
    (Story) => (
      <div className="flex w-75 flex-col gap-1.5 rounded-xl bg-surface p-4">
        <Story />
      </div>
    ),
  ],
};
export default meta;

type Story = StoryObj<typeof GuildRow>;

export const Playground: Story = {
  args: { defaultOpen: false },
};

/** Default, selected and collapsed, as the rows sit in the sidebar. */
export const Rows: Story = {
  render: () => (
    <>
      <GuildRow name="X-Replies" agentCount={2} maxAgents={15} defaultOpen={false} />
      <GuildRow name="Degen-capital" agentCount={4} maxAgents={15} selected defaultOpen={false} />
      <GuildRow
        name="Link-Prospection"
        agentCount={2}
        maxAgents={15}
        defaultOpen={false}
        visibility="private"
      />
    </>
  ),
};

export const Expanded: Story = {
  render: () => (
    <>
      <GuildRow name="X-Replies" agentCount={2} maxAgents={15} onAddAgent={() => {}}>
        <AgentRow name="cigale-agent" tone="signal" state="idle" />
        <AgentRow name="x-access" tone="dusk" state="running" browser />
      </GuildRow>
      <GuildRow name="Degen-capital" agentCount={4} maxAgents={15} selected onAddAgent={() => {}}>
        <AgentRow name="skyzo" tone="signal" state="running" />
        <AgentRow name="researchoor" tone="moss" state="idle" browser />
        <AgentRow name="wallet" tone="tide" state="idle" selected />
        <AgentRow name="managooor" tone="rosewood" state="idle" />
      </GuildRow>
    </>
  ),
};

/** At its agent limit the add row is disabled and says why. */
export const Full: Story = {
  render: () => (
    <GuildRow name="Link-Prospection" agentCount={2} maxAgents={2} onAddAgent={() => {}}>
      <AgentRow name="linkedin-researcher" tone="tide" state="idle" browser />
      <AgentRow name="linkedin-messenger" tone="signal" state="idle" browser />
    </GuildRow>
  ),
};
