import type { Meta, StoryObj } from "@storybook/react-vite";
import { AgentStatus } from "./AgentStatus";
import { Avatar } from "./Avatar";

const meta: Meta<typeof AgentStatus> = {
  title: "Components/Identity/AgentStatus",
  component: AgentStatus,
  args: { state: "running" },
};
export default meta;

type Story = StoryObj<typeof AgentStatus>;

export const Playground: Story = {
  decorators: [
    (Story) => (
      <div className="rounded-xl bg-surface p-6">
        <Story />
      </div>
    ),
  ],
};

const agents = [
  { name: "skyzo", tone: "signal", state: "running" },
  { name: "wallet", tone: "tide", state: "idle" },
  { name: "managooor", tone: "rosewood", state: "connecting" },
] as const;

export const States: Story = {
  render: () => (
    <div className="flex max-w-xs flex-col gap-3 rounded-xl bg-surface p-6">
      {agents.map((agent) => (
        <div key={agent.name} className="flex items-center gap-2.5 rounded-md bg-paper px-2.5 py-2">
          <Avatar name={agent.name} tone={agent.tone} size={24} />
          <span className="flex-1 font-mono text-sm">{agent.name}</span>
          <AgentStatus state={agent.state} />
        </div>
      ))}
    </div>
  ),
};
