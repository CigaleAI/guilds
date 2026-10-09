import type { Meta, StoryObj } from "@storybook/react-vite";
import { Term } from "./Term";

const meta: Meta<typeof Term> = {
  title: "Components/Identity/Term",
  component: Term,
  args: { children: "RECONCILIATION_REQUIRED" },
};
export default meta;

type Story = StoryObj<typeof Term>;

export const Playground: Story = {
  decorators: [
    (Story) => (
      <div className="rounded-xl bg-paper p-6">
        <Story />
      </div>
    ),
  ],
};

export const InProse: Story = {
  render: () => (
    <div className="max-w-xl rounded-xl bg-paper p-6 text-md text-fg">
      An intermediate swap without the target purchase is marked{" "}
      <Term>RECONCILIATION_REQUIRED</Term>, not filled. Set <Term>WALLET_KEY</Term> to resume
      valuation.
    </div>
  ),
};
