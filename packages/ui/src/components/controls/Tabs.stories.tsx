import type { Meta, StoryObj } from "@storybook/react-vite";
import {
  CircleDollarSign,
  FilePen,
  FileText,
  Globe,
  History,
  KeyRound,
  Layers,
  MessageSquare,
  MessagesSquare,
  Repeat,
  Settings,
  SquareTerminal,
  Wrench,
} from "lucide-react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "./Tabs";

const meta: Meta<typeof Tabs> = { title: "Components/Controls/Tabs", component: Tabs };
export default meta;

type Story = StoryObj<typeof Tabs>;

export const Track: Story = {
  render: () => (
    <div className="rounded-xl bg-surface p-6">
      <Tabs defaultValue="chat" className="gap-4">
        <TabsList aria-label="Guild views">
          <TabsTrigger value="chat">Group chat</TabsTrigger>
          <TabsTrigger value="files">Files</TabsTrigger>
          <TabsTrigger value="issues" count={26}>
            Issues
          </TabsTrigger>
        </TabsList>
        <TabsContent value="chat" className="text-md text-fg-2">
          wallet posted the 03:00 treasury run to Degen-capital.
        </TabsContent>
        <TabsContent value="files" className="text-md text-fg-2">
          portfolio_valuation.md · research_log.md
        </TabsContent>
        <TabsContent value="issues" className="text-md text-fg-2">
          26 open issues, 3 blocked on WALLET_KEY.
        </TabsContent>
      </Tabs>
    </div>
  ),
};

const guildTabs = [
  { value: "chat", label: "Group chat" },
  { value: "settings", label: "Settings" },
  { value: "state", label: "State" },
  { value: "routines", label: "Routines" },
  { value: "issues", label: "Issues", count: 26 },
  { value: "tools", label: "Tools" },
  { value: "secrets", label: "Secrets" },
  { value: "usage", label: "Usage" },
];

export const GuildBar: Story = {
  render: () => (
    <div className="overflow-hidden rounded-2xl bg-paper">
      <div className="bg-plum px-10 py-7 text-on-plum">
        <span className="type-label text-on-plum-muted">Guild</span>
        <p className="type-h2">Degen-capital</p>
      </div>
      <Tabs defaultValue="issues">
        <TabsList look="bar" aria-label="Guild pages" className="border-t-0 px-4 py-2">
          {guildTabs.map((tab) => (
            <TabsTrigger
              key={tab.value}
              value={tab.value}
              {...(tab.count ? { count: tab.count } : {})}
            >
              {tab.label}
            </TabsTrigger>
          ))}
        </TabsList>
        {guildTabs.map((tab) => (
          <TabsContent key={tab.value} value={tab.value} className="p-6 text-md text-fg-2">
            {tab.label} for Degen-capital.
          </TabsContent>
        ))}
      </Tabs>
    </div>
  ),
};

const agentTabs = [
  { value: "chat", label: "Chat", icon: MessageSquare },
  { value: "prompt", label: "Prompt", icon: FilePen },
  { value: "state", label: "State", icon: Layers },
  { value: "history", label: "History", icon: History },
  { value: "routine", label: "Routine", icon: Repeat },
  { value: "browser", label: "Browser", icon: Globe },
  { value: "cli", label: "CLI", icon: SquareTerminal },
  { value: "tools", label: "Tools", icon: Wrench },
  { value: "secrets", label: "Secrets", icon: KeyRound },
  { value: "usage", label: "Usage", icon: CircleDollarSign },
  { value: "settings", label: "Settings", icon: Settings },
];

function Inspector({ width, icons }: { width: string; icons: boolean }) {
  return (
    <div className={`overflow-hidden rounded-2xl bg-paper ${width}`}>
      <div className="px-7 pt-6 pb-5">
        <p className="font-mono text-2xl font-medium text-fg">researchoor</p>
        <p className="text-md text-fg-2">Research projects, digest charts and report.</p>
      </div>
      <Tabs defaultValue="state">
        <TabsList look="bar" aria-label="Agent pages">
          {agentTabs.map((tab) => (
            <TabsTrigger key={tab.value} value={tab.value} {...(icons ? { icon: tab.icon } : {})}>
              {tab.label}
            </TabsTrigger>
          ))}
        </TabsList>
        {agentTabs.map((tab) => (
          <TabsContent key={tab.value} value={tab.value} className="px-7 py-6 text-md text-fg-2">
            researchoor · {tab.label}
          </TabsContent>
        ))}
      </Tabs>
    </div>
  );
}

export const InspectorBar: Story = {
  render: () => (
    <div className="rounded-3xl bg-dusk p-8">
      <Inspector width="w-full" icons={false} />
    </div>
  ),
};

export const Overflowing: Story = {
  render: () => (
    <div className="flex flex-col gap-4 rounded-3xl bg-dusk p-8">
      <Inspector width="max-w-xl" icons />
      <div className="max-w-60 rounded-xl bg-surface p-4">
        <Tabs defaultValue="issues">
          <TabsList aria-label="Guild views">
            <TabsTrigger value="chat" icon={MessagesSquare}>
              Group chat
            </TabsTrigger>
            <TabsTrigger value="files" icon={FileText}>
              Files
            </TabsTrigger>
            <TabsTrigger value="issues" count={26}>
              Issues
            </TabsTrigger>
          </TabsList>
          <TabsContent value="chat" />
          <TabsContent value="files" />
          <TabsContent value="issues" />
        </Tabs>
      </div>
    </div>
  ),
};
