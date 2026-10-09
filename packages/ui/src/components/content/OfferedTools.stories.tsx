import type { Meta, StoryObj } from "@storybook/react-vite";
import { OfferedTools, type OfferedToolGroup } from "./OfferedTools";
import { PromptSections } from "./PromptSections";

const meta: Meta<typeof OfferedTools> = {
  title: "Components/Content/OfferedTools",
  component: OfferedTools,
  decorators: [
    (Story) => (
      <div className="max-w-3xl rounded-xl bg-paper p-6">
        <Story />
      </div>
    ),
  ],
};
export default meta;

type Story = StoryObj<typeof OfferedTools>;

const groups: OfferedToolGroup[] = [
  {
    server: "guilds.run",
    tools: [
      { name: "note_find", description: "Search notes by text across readable levels." },
      { name: "note_get", description: "Read one note by display path." },
      { name: "note_write", description: "Create or replace a note at agent, guild or org level." },
      { name: "note_delete", description: "Delete a note you own." },
      {
        name: "memory_write",
        description: "Replace your memory body; the previous one is kept as a revision.",
      },
      { name: "record_list" },
      { name: "record_add" },
      { name: "record_update" },
      { name: "schedule_list" },
      { name: "schedule_create_cron" },
      { name: "schedule_create_window" },
      { name: "script_list" },
      { name: "script_run" },
      { name: "group_post" },
      { name: "tavily_search" },
    ],
  },
  {
    server: "alchemy",
    tools: [
      { name: "get_token_balances" },
      { name: "get_nfts_for_owner" },
      { name: "get_asset_transfers" },
    ],
  },
  {
    server: "coingecko",
    tools: [{ name: "simple_price" }, { name: "coins_markets" }],
  },
];

export const Collapsed: Story = {
  args: { groups },
};

export const Expanded: Story = {
  args: { groups, defaultOpen: true },
};

export const InInspector: Story = {
  render: () => (
    <div className="flex flex-col gap-3">
      <OfferedTools groups={groups} />
      <PromptSections sections={{ guidelines: "…", task: "…", state: "…", memory: "…" }} />
    </div>
  ),
};
