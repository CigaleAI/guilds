import type { Meta, StoryObj } from "@storybook/react-vite";
import { BookOpen, Database, Inbox, Sparkles } from "lucide-react";
import { useState } from "react";
import type { IdentityTone } from "../../identity";
import { BrandMark } from "../identity/BrandMark";
import type { AgentState } from "../identity/AgentStatus";
import { AgentRow } from "./AgentRow";
import { GuildRow, type GuildVisibility } from "./GuildRow";
import { Sidebar } from "./Sidebar";
import { SidebarSection } from "./SidebarSection";
import { UtilityLink } from "./UtilityLink";

const meta: Meta<typeof Sidebar> = {
  title: "Components/Navigation/Sidebar",
  component: Sidebar,
  parameters: { layout: "fullscreen" },
};
export default meta;

type Story = StoryObj<typeof Sidebar>;

type Agent = { name: string; tone: IdentityTone; state: AgentState; browser?: boolean };
type Guild = { name: string; maxAgents: number; visibility?: GuildVisibility; agents: Agent[] };

const guilds: Guild[] = [
  {
    name: "X-Replies",
    maxAgents: 15,
    agents: [
      { name: "cigale-agent", tone: "signal", state: "idle" },
      { name: "x-access", tone: "dusk", state: "running", browser: true },
    ],
  },
  {
    name: "Cigale-Replies-Auto",
    maxAgents: 15,
    agents: [
      { name: "cigaler", tone: "dusk", state: "idle" },
      { name: "x-connector", tone: "dusk", state: "idle", browser: true },
    ],
  },
  {
    name: "Degen-capital",
    maxAgents: 15,
    agents: [
      { name: "skyzo", tone: "signal", state: "running" },
      { name: "researchoor", tone: "moss", state: "idle", browser: true },
      { name: "wallet", tone: "tide", state: "idle" },
      { name: "managooor", tone: "rosewood", state: "idle" },
    ],
  },
  {
    name: "Link-Prospection",
    maxAgents: 15,
    visibility: "private",
    agents: [
      { name: "linkedin-researcher", tone: "tide", state: "idle", browser: true },
      { name: "linkedin-messenger", tone: "signal", state: "idle", browser: true },
    ],
  },
];

function Workspace() {
  const [guild, setGuild] = useState("Degen-capital");
  const [agent, setAgent] = useState("wallet");
  return (
    <Sidebar
      brand={
        <span className="flex items-center gap-2.5">
          <BrandMark size={28} wordmark />
          <span
            role="status"
            aria-label="Orchestrator online"
            title="Orchestrator online"
            className="size-2 rounded-full bg-signal"
          />
        </span>
      }
      onRetract={() => {}}
      section={
        <SidebarSection
          label="Guilds"
          count={guilds.length}
          onAdd={() => {}}
          addLabel="Create guild"
        />
      }
      footer={
        <>
          <UtilityLink
            density="compact"
            icon={Inbox}
            tone="plum"
            title="Inbox"
            count={26}
          />
          <UtilityLink
            density="compact"
            icon={Sparkles}
            tone="signal"
            title="Builder"
          />
          <UtilityLink
            density="compact"
            icon={BookOpen}
            tone="plum-tint"
            title="Recipes"
          />
          <UtilityLink
            density="compact"
            icon={Database}
            tone="signal-tint"
            title="Databases"
          />
        </>
      }
      className="h-full"
    >
      {guilds.map((g) => (
        <GuildRow
          key={g.name}
          name={g.name}
          agentCount={g.agents.length}
          maxAgents={g.maxAgents}
          {...(g.visibility ? { visibility: g.visibility } : {})}
          selected={g.name === guild}
          onSelect={() => setGuild(g.name)}
          onAddAgent={() => {}}
        >
          {g.agents.map((a) => (
            <AgentRow
              key={a.name}
              name={a.name}
              tone={a.tone}
              state={a.state}
              browser={a.browser ?? false}
              selected={a.name === agent}
              onClick={() => {
                setGuild(g.name);
                setAgent(a.name);
              }}
            />
          ))}
        </GuildRow>
      ))}
    </Sidebar>
  );
}

export const Default: Story = {
  render: () => (
    <div className="flex h-280 bg-well p-5">
      <Workspace />
    </div>
  ),
};
