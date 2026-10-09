import type { Meta, StoryObj } from "@storybook/react-vite";
import { StackedQueue } from "./StackedQueue";

const meta: Meta<typeof StackedQueue> = {
  title: "Components/Blocks/StackedQueue",
  component: StackedQueue,
  decorators: [
    (Story) => (
      <div className="max-w-sm rounded-xl bg-surface p-6">
        <Story />
      </div>
    ),
  ],
};
export default meta;

type Story = StoryObj<typeof StackedQueue>;

export const LiveFirst: Story = {
  args: {
    items: [
      {
        id: "run_3c44",
        state: "live",
        title: "wallet · hourly treasury",
        meta: "run_3c44 · step 3 of 4 · 0:42",
      },
      {
        id: "iss_01M3E",
        state: "attention",
        title: "Wallet credentials missing",
        meta: "high · since 03:00 UTC",
      },
      { id: "routine_retro", state: "healthy", title: "researchoor · daily retro", meta: "09:00" },
    ],
  },
};

export const NeedsAttentionFirst: Story = {
  args: {
    items: [
      {
        id: "iss_01M3E",
        state: "attention",
        title: "Wallet credentials missing",
        meta: "blocked since 03:00 UTC",
      },
      {
        id: "routine_treasury",
        state: "healthy",
        title: "wallet · hourly treasury",
        meta: "10:00",
      },
    ],
  },
};

export const Selectable: Story = {
  args: {
    onSelect: () => undefined,
    items: [
      {
        id: "run_3c44",
        state: "live",
        title: "wallet · hourly treasury",
        meta: "run_3c44 · step 3 of 4 · 0:42",
      },
      { id: "iss_01M3E", state: "attention", title: "Wallet credentials missing" },
      { id: "routine_retro", state: "healthy", title: "researchoor · daily retro", meta: "09:00" },
    ],
  },
};
