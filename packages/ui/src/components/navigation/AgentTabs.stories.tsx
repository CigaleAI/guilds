import type { Meta, StoryObj } from "@storybook/react-vite";
import { TriangleAlert } from "lucide-react";
import { useState } from "react";
import { Icon } from "../../primitives/Icon";
import { Tag } from "../../primitives/Tag";
import { AgentTabs, type AgentTab } from "./AgentTabs";

const meta: Meta<typeof AgentTabs> = {
  title: "Components/Navigation/AgentTabs",
  component: AgentTabs,
  parameters: { layout: "fullscreen" },
};
export default meta;

type Story = StoryObj<typeof AgentTabs>;

const guild: AgentTab[] = [
  { id: "a1", name: "managooor", tone: "rosewood", version: 8 },
  {
    id: "a2",
    name: "researchoor",
    tone: "tide",
    version: 17,
    marks: (
      <Tag tone="signal" font="sans">
        draft
      </Tag>
    ),
  },
  { id: "a3", name: "skyzo", tone: "signal", version: 12 },
  {
    id: "a4",
    name: "wallet",
    tone: "ochre",
    version: 9,
    title: "Missing a login",
    marks: <Icon icon={TriangleAlert} size={14} className="text-t-ochre-fg" />,
  },
];

function Demo({ agents }: { agents: AgentTab[] }) {
  const [current, setCurrent] = useState<string | null>(null);
  return (
    <div className="bg-paper">
      <AgentTabs
        overview={{ label: "Guild overview" }}
        agents={agents}
        current={current}
        onSelect={setCurrent}
      />
    </div>
  );
}

export const Guild: Story = { render: () => <Demo agents={guild} /> };

/** Past four agents a filter joins the strip; the selected agent always stays. */
export const WithFilter: Story = {
  render: () => (
    <Demo
      agents={[
        ...guild,
        { id: "a5", name: "scout", tone: "moss", version: 3 },
        { id: "a6", name: "treasurer", tone: "dusk", version: 5 },
      ]}
    />
  ),
};
