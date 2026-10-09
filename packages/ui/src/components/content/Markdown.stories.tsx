import type { Meta, StoryObj } from "@storybook/react-vite";
import { Bubble } from "../../primitives/Bubble";
import { Markdown } from "./Markdown";

const meta: Meta<typeof Markdown> = {
  title: "Components/Content/Markdown",
  component: Markdown,
};
export default meta;

type Story = StoryObj<typeof Markdown>;

const guildBrief = `# Degen Venture

Degen trading firm. Memecoins and NFTs. Hear it in the trenches, size it, fill it. See the [fund thesis](https://guilds.run/degen-capital/fund-thesis).

## Desk

- One scout, terminally online.
- researchoor scores every lead before it reaches the manager.
- wallet executes only manager‑authorised orders.

Orders land in \`degen-orders\` with status \`PENDING\`.

\`\`\`yaml
# order limits
max_order_usd: 1000
reserve_eth: 0.05
\`\`\`

> Moon or get rekt — never on unverified balances.

| Stage | Action |
| --- | --- |
| nascent | watch |
| mooning | size ≤ $1k |
`;

const memory = `Require a verified contract plus current market/onchain traction before retaining a Scout lead in research; correct chain metadata when Scout records conflict with canonical identifiers. Scheduled passes use only prior-hour social data. Portfolio wake-ups must not change portfolio status, allocation or orders. Top-10 concentration above 25% should generally fail unless strong independent usage evidence offsets it.

2026-09-26 12:35Z scheduled watch pass found zero degen-projects records with status watch; no assessments or snapshots were needed.

Await next selected queue. Watch pass at 12:35Z had zero watch projects: 0 assessments, 0 snapshots, 0 transitions, 0 manager alerts.
`;

const taskWithEmbeds = `Every 24h, run a retrospective with researchoor. Check closed and exited calls against ![[org/org_01j9x2k7/guilds/g_01j9x3m1/fund-thesis.md]] and log each decision in ![[org/org_01j9x2k7/collections/degen-orders]].

Keep your scoring rules in ![[org/org_01j9x2k7/agents/a_01j9x4p2/scoring.md]].

Text inside code stays literal: \`![[org/org_01j9x2k7/guilds/g_01j9x3m1/fund-thesis.md]]\`.
`;

const everythingElse = `### Before sizing a trade

1. Read the latest treasury report from wallet.
2. Confirm balances on every configured chain:
   - Ethereum and Base via Alchemy
   - Solana via Helius
3. Post the order to managooor for approval.

- [x] WALLET_KEY bound to wallet
- [ ] COINGECKO_KEY bound to wallet

~~Report every hour, even when flat.~~ Report hourly; stay silent when nothing changed.

---

Raw HTML is shown as text, never rendered: <script>alert("gm")</script> <b>not bold</b>
`;

export const Document: Story = {
  render: () => (
    <div className="max-w-md rounded-xl bg-surface p-5">
      <div className="rounded-lg bg-paper px-6 py-5">
        <Markdown>{guildBrief}</Markdown>
      </div>
    </div>
  ),
};

export const NoteView: Story = {
  render: () => (
    <div className="rounded-xl bg-paper px-6 py-5">
      <Markdown>{memory}</Markdown>
    </div>
  ),
};

export const Embeds: Story = {
  render: () => (
    <div className="rounded-xl bg-surface p-5">
      <div className="rounded-lg bg-paper px-6 py-5">
        <Markdown
          isBrokenEmbed={(path) => path.endsWith("scoring.md")}
          onOpenEmbed={() => undefined}
        >
          {taskWithEmbeds}
        </Markdown>
      </div>
    </div>
  ),
};

export const ListsAndRules: Story = {
  render: () => (
    <div className="rounded-xl bg-paper px-6 py-5">
      <Markdown>{everythingElse}</Markdown>
    </div>
  ),
};

export const ChatMessages: Story = {
  render: () => (
    <div className="flex max-w-2xl flex-col gap-4 rounded-xl bg-surface p-6">
      <Bubble variant="agent">
        <Markdown density="compact">
          {`**HOURLY TREASURY — 03:00 UTC**

- **Valuation incomplete:** wallet credentials are missing; live balances across configured chains could not be verified.
- Fresh ETH/USD and SOL/USD unavailable: CoinGecko API key is missing.
- Total priced portfolio: **unavailable**

Updated \`portfolio_valuation.md\` · No orders executed.`}
        </Markdown>
      </Bubble>
      <Bubble variant="human">
        <Markdown density="compact" tone="tinted">
          {`If the manager requires a **$1k buy** but wallet only holds the native token on that chain, swap the equivalent amount of ETH first.

See ![[org/org_01j9x2k7/guilds/g_01j9x3m1/fund-thesis.md]] and \`degen-orders\`.`}
        </Markdown>
      </Bubble>
      <Bubble variant="agent">
        <Markdown density="compact">
          {`## Retro · 26 Sep

| Call | Result |
| --- | --- |
| PEPE2 | exited +38% |
| MOODENG | closed −12% |

\`\`\`
record_search degen-orders status=PENDING → 0 records
\`\`\``}
        </Markdown>
      </Bubble>
    </div>
  ),
};

/** Only the handles the message tagged become chips; other `@words` stay text. */
export const TaggedMentions: Story = {
  render: () => (
    <div className="flex max-w-xl flex-col gap-3 rounded-xl bg-surface p-6">
      <Bubble variant="agent">
        <Markdown density="compact" mentions={["wallet", "user"]}>
          {"@wallet re-check balances before sizing. @user: WALLET_KEY is still missing. Mail ops@guilds.run if stuck."}
        </Markdown>
      </Bubble>
      <Bubble variant="human">
        <Markdown density="compact" tone="tinted" mentions={["managooor"]}>
          {"@managooor hold every BUY until the key is set."}
        </Markdown>
      </Bubble>
    </div>
  ),
};
