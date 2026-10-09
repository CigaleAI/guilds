import type { Meta, StoryObj } from "@storybook/react-vite";
import { PromptSections } from "./PromptSections";

const meta: Meta<typeof PromptSections> = {
  title: "Components/Content/PromptSections",
  component: PromptSections,
  decorators: [
    (Story) => (
      <div className="max-w-3xl rounded-xl bg-paper p-6">
        <Story />
      </div>
    ),
  ],
};
export default meta;

type Story = StoryObj<typeof PromptSections>;

const sections = {
  guidelines: `You are one agent in a guild. Task, State and Memory below are sections of this opening system message.

State already carries utc_now and utc_date; never invent a date. Each tool result ends with remaining_tool_calls: N. At 8 or fewer, stop exploring, write findings and finish with text.

Give each datum one canonical home: agent notes and Memory for private continuity, guild and org notes for shared knowledge, collections for records.

You are managooor. Your id is a_01j9x4p2.`,
  task: `The operator's standing purpose for you. Follow it. You do not rewrite this section; it is not yours to edit with memory_write.

You run the degen fund. Moon or rekt, it's on you.
Never size a trade without verified wallet balances.
Every 24h, run a retrospective with researchoor.

<fund-thesis path="org/org_01j9x2k7/guilds/g_01j9x3m1/fund-thesis.md" level="guild">
Memecoins and NFTs. Hear it in the trenches, size it, fill it.
</fund-thesis>`,
  state: `A snapshot of the guild at the start of this run.

{
  "utc_now": "2026-09-26T09:00:00Z",
  "utc_date": "Saturday 2026-09-26",
  "max_tool_calls": 40,
  "group": {
    "about": "Degen trading firm. Memecoins and NFTs.",
    "members": [{ "name": "wallet" }, { "name": "researchoor" }, { "name": "skyzo" }]
  },
  "collections": [{ "name": "degen-orders", "access": "write", "scope": "guild" }]
}`,
  memory: `Fund stays flat until wallet credentials recover.
2026-09-26 05:00Z no BUY/SELL orders created; valuation unverifiable.
Re-check treasury after WALLET_KEY is bound.`,
};

export const Collapsed: Story = {
  args: { sections },
};

export const Expanded: Story = {
  args: { sections, defaultOpen: true },
};
