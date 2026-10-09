import type { Meta, StoryObj } from "@storybook/react-vite";
import { useState } from "react";
import type { BindingOrigin } from "../controls/OnOffSwitch";
import { ToolRow } from "./ToolRow";

const meta: Meta<typeof ToolRow> = {
  title: "Components/Data/ToolRow",
  component: ToolRow,
  decorators: [
    (Story) => (
      <div className="max-w-xl rounded-xl bg-surface p-6">
        <div className="overflow-hidden rounded-lg bg-paper">
          <Story />
        </div>
      </div>
    ),
  ],
};
export default meta;

type Story = StoryObj<typeof ToolRow>;

type Binding = { name: string; enabled: boolean; source: string; origin: BindingOrigin };

function Demo({ initial }: { initial: Binding[] }) {
  const [tools, setTools] = useState(initial);
  return (
    <>
      {tools.map((tool) => (
        <ToolRow
          key={tool.name}
          name={tool.name}
          server="cigale"
          enabled={tool.enabled}
          source={tool.source}
          origin={tool.origin}
          onEnabledChange={(enabled) =>
            setTools((list) =>
              list.map((item) =>
                item.name === tool.name ? { ...item, enabled, source: "agent", origin: { kind: "overridden" } } : item,
              ),
            )
          }
        />
      ))}
    </>
  );
}

export const InheritedAndOverridden: Story = {
  render: () => (
    <Demo
      initial={[
        { name: "draft_reply", enabled: false, source: "agent", origin: { kind: "overridden" } },
        { name: "trend_report", enabled: true, source: "guild", origin: { kind: "inherited", from: "guild" } },
        { name: "search_top_posts", enabled: true, source: "agent", origin: { kind: "overridden" } },
        { name: "semantic_find_posts", enabled: false, source: "org", origin: { kind: "inherited", from: "org" } },
      ]}
    />
  ),
};

export const LongNameAndDisabled: Story = {
  render: () => (
    <>
      <ToolRow
        name="get_campaign_top_reply_opportunities_for_label"
        server="cigale"
        enabled
        source="guild"
        origin={{ kind: "inherited", from: "guild" }}
        onEnabledChange={() => {}}
      />
      <ToolRow name="note_find" enabled source="platform" onEnabledChange={() => {}} disabled />
    </>
  ),
};
