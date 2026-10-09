import type { Meta, StoryObj } from "@storybook/react-vite";
import { diffLines, type DiffLine } from "./diff";
import { DiffView } from "./DiffView";

const meta: Meta<typeof DiffView> = {
  title: "Components/Content/DiffView",
  component: DiffView,
  decorators: [
    (Story) => (
      <div className="max-w-3xl rounded-xl bg-surface p-5">
        <Story />
      </div>
    ),
  ],
};
export default meta;

type Story = StoryObj<typeof DiffView>;

const revision: DiffLine[] = [
  { kind: "ctx", text: "Never size a trade without verified wallet balances.", oldNo: 4, newNo: 4 },
  { kind: "del", text: "Report every hour, even when flat.", oldNo: 5 },
  { kind: "add", text: "Report hourly; stay silent when nothing changed.", newNo: 5 },
  { kind: "add", text: "Run a retrospective every 24h with researchoor.", newNo: 6 },
  {
    kind: "ctx",
    text: "Orders go to ![[org/org_01j9x2k7/collections/degen-orders]] with status PENDING.",
    oldNo: 6,
    newNo: 7,
  },
];

const liveTask = `You run the degen fund. Moon or rekt, it's on you.

## Every hour
- Read the latest treasury report from wallet before sizing anything.
- Never size a trade without verified wallet balances.
- Orders go to ![[org/org_01j9x2k7/collections/degen-orders]] with status PENDING.
- Report every hour, even when flat.

## Sizing
- Nascent: watch only.
- Mooning: size up to $1k.
- Fading: exit half, trail the rest.
- Never hold more than 25% of the fund in one token.
- Keep 0.05 ETH on every chain for gas.
- Ask researchoor for a score before any new position.
- Ignore calls from accounts younger than 30 days.

## Every 24h
Write the daily summary to the fund thesis.`;

const draftTask = `You run the degen fund. Moon or rekt, it's on you.

## Every hour
- Read the latest treasury report from wallet before sizing anything.
- Never size a trade without verified wallet balances.
- Orders go to ![[org/org_01j9x2k7/collections/degen-orders]] with status PENDING.
- Report hourly; stay silent when nothing changed.

## Sizing
- Nascent: watch only.
- Mooning: size up to $1k.
- Fading: exit half, trail the rest.
- Never hold more than 25% of the fund in one token.
- Keep 0.05 ETH on every chain for gas.
- Ask researchoor for a score before any new position.
- Ignore calls from accounts younger than 30 days.

## Every 24h
Run a retrospective with researchoor: check closed and exited calls, see how decisions held up, and fold the learnings into ![[org/org_01j9x2k7/guilds/g_01j9x3m1/fund-thesis.md]].`;

export const Unified: Story = {
  args: { title: "task · v7 → v8", lines: revision },
};

export const Split: Story = {
  args: { title: "task · v7 → v8", lines: revision, defaultLayout: "split" },
};

export const StudioDraft: Story = {
  args: { title: "managooor · live → draft", lines: diffLines(liveTask, draftTask) },
};

export const StudioDraftSplit: Story = {
  args: {
    title: "managooor · live → draft",
    lines: diffLines(liveTask, draftTask),
    defaultLayout: "split",
  },
};

export const NoChanges: Story = {
  args: { title: "task · v8 → v9", lines: diffLines(liveTask, liveTask) },
};
