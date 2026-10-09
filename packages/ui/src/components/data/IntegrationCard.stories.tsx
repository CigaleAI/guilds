import type { Meta, StoryObj } from "@storybook/react-vite";
import { useState } from "react";
import { Button } from "../actions/Button";
import { ToolRow } from "./ToolRow";
import { IntegrationCard, type IntegrationCardProps } from "./IntegrationCard";

const meta: Meta<typeof IntegrationCard> = {
  title: "Components/Data/IntegrationCard",
  component: IntegrationCard,
};
export default meta;

type Story = StoryObj<typeof IntegrationCard>;

const cigaleTools = [
  { name: "generate_reply_options", enabled: false },
  { name: "get_predicted_views", enabled: true },
  { name: "get_recent_documents", enabled: true },
  { name: "search_top_posts", enabled: true },
  { name: "trend_report_by_topic", enabled: false },
];

function Demo(props: Partial<IntegrationCardProps> & { defaultExpanded?: boolean }) {
  const { defaultExpanded = false, ...rest } = props;
  const [enabled, setEnabled] = useState(rest.enabled ?? true);
  const [expanded, setExpanded] = useState(defaultExpanded);
  const [tools, setTools] = useState(cigaleTools);
  return (
    <IntegrationCard
      name="Cigale"
      logoTone="plum"
      status="connected"
      source="guild"
      description="Social research and reply drafting from Cigale's tweet index. Search a topic's best posts, find X posts from the last 24h, pull trend reports and draft replies in an agent's voice."
      tools={{ active: tools.filter((tool) => tool.enabled).length, total: tools.length }}
      {...rest}
      enabled={enabled}
      onEnabledChange={setEnabled}
      expanded={expanded}
      onExpandedChange={setExpanded}
    >
      {tools.map((tool) => (
        <ToolRow
          key={tool.name}
          name={tool.name}
          server="cigale"
          enabled={tool.enabled}
          source={tool.enabled ? "guild" : "agent"}
          origin={tool.enabled ? { kind: "inherited", from: "guild" } : { kind: "overridden" }}
          onEnabledChange={(next) =>
            setTools((list) =>
              list.map((item) => (item.name === tool.name ? { ...item, enabled: next } : item)),
            )
          }
        />
      ))}
    </IntegrationCard>
  );
}

export const OnSurface: Story = {
  render: () => (
    <div className="flex flex-col gap-4 rounded-xl bg-surface p-6">
      <Demo
        name="Alchemy"
        logoTone="panel"
        description="NFT holdings, metadata and collection data across supported chains."
        tools={{ active: 3, total: 3 }}
      />
      <Demo />
    </div>
  ),
};

export const ExpandedOnPaper: Story = {
  render: () => (
    <div className="flex flex-col gap-4 rounded-xl bg-paper p-6">
      <Demo tone="surface" defaultExpanded />
    </div>
  ),
};

export const Statuses: Story = {
  render: () => (
    <div className="flex flex-col gap-4 rounded-xl bg-surface p-6">
      <Demo
        name="Notion"
        logoTone="paper"
        status="connected"
        accountHint="emma@degen.capital"
        actions={
          <Button variant="outline" size="md">
            Disconnect
          </Button>
        }
        description="Search and read pages in the connected workspace."
        tools={{ active: 4, total: 6 }}
      />
      <Demo
        name="Gmail"
        logoTone="dusk"
        status="disconnected"
        actions={
          <Button variant="outline" size="md">
            Connect
          </Button>
        }
        source="agent"
        enabled={false}
        origin={{ kind: "overridden" }}
        description="Read, label and draft mail for the connected inbox."
        tools={{ active: 0, total: 5 }}
      />
      <Demo
        name="CoinGecko"
        logoTone="tide"
        status="pending"
        description="Prices, market caps and trending coins."
        tools={{ active: 2, total: 4 }}
      />
    </div>
  ),
};

export const Narrow: Story = {
  render: () => (
    <div className="flex w-96 flex-col gap-4 rounded-xl bg-surface p-4">
      <Demo
        name="Gmail"
        logoTone="dusk"
        status="connected"
        accountHint="ops@degen.capital"
        actions={
          <Button variant="outline" size="md">
            Disconnect
          </Button>
        }
        description="Read, label and draft mail for the connected inbox."
        tools={{ active: 5, total: 5 }}
      />
      <Demo defaultExpanded />
    </div>
  ),
};
