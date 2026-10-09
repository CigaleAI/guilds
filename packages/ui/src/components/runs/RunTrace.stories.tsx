import type { Meta, StoryObj } from "@storybook/react-vite";
import { RunTrace } from "./RunTrace";

const meta: Meta<typeof RunTrace> = {
  title: "Components/Runs/RunTrace",
  component: RunTrace,
  args: {
    title: "run_3a91",
    meta: "2.4s · $0.03",
    lines: [
      { status: "ok", label: "read chains.yaml", meta: "0.1s" },
      { status: "failed", label: "fetch balances", meta: "0.8s" },
      { status: "ok", label: "write valuation", meta: "0.9s" },
    ],
  },
};
export default meta;

type Story = StoryObj<typeof RunTrace>;

export const Playground: Story = {
  render: (args) => (
    <div className="max-w-xs rounded-xl bg-surface p-6">
      <RunTrace {...args} />
    </div>
  ),
};

export const UnderAMessage: Story = {
  render: () => (
    <div className="max-w-xl rounded-xl bg-surface p-5">
      <RunTrace
        title="run_3c44"
        meta="4 steps · 2.4s · $0.03"
        lines={[
          {
            status: "ok",
            label: "note_get org/degen/guilds/degen-capital/chains.yaml",
            meta: "112ms",
          },
          { status: "failed", label: "script_run fetch_balances.py", meta: "812ms" },
          { status: "ok", label: "note_write portfolio_valuation.md", meta: "22ms" },
          { status: "running", label: "group_post" },
        ]}
      />
    </div>
  ),
};
