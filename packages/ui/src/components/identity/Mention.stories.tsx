import type { Meta, StoryObj } from "@storybook/react-vite";
import { FileRef } from "./FileRef";
import { Mention } from "./Mention";
import { ToolChip } from "./ToolChip";

const meta: Meta<typeof Mention> = {
  title: "Components/Identity/Mention",
  component: Mention,
  args: { handle: "managooor" },
};
export default meta;

type Story = StoryObj<typeof Mention>;

export const Playground: Story = {
  decorators: [
    (Story) => (
      <div className="rounded-xl bg-surface p-6">
        <Story />
      </div>
    ),
  ],
};

/** Inline chips sit on the text baseline inside an agent message. */
export const InMessage: Story = {
  render: () => (
    <div className="max-w-xl rounded-xl bg-paper p-6 text-md text-fg">
      <Mention handle="managooor" /> valuation incomplete: live wallet reads failed on every
      configured chain. Updated <FileRef path="portfolio_valuation.md" /> after{" "}
      <ToolChip name="note_find" tone="well" /> found the prior snapshot. No orders executed.
    </div>
  ),
};
