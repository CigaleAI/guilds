import type { Meta, StoryObj } from "@storybook/react-vite";
import { FileRef } from "./FileRef";

const meta: Meta<typeof FileRef> = {
  title: "Components/Identity/FileRef",
  component: FileRef,
  args: { path: "portfolio_valuation.md" },
};
export default meta;

type Story = StoryObj<typeof FileRef>;

export const Playground: Story = {
  decorators: [
    (Story) => (
      <div className="rounded-xl bg-paper p-6">
        <Story />
      </div>
    ),
  ],
};

export const Grounds: Story = {
  render: () => (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2 rounded-xl bg-paper p-6">
        <FileRef path="portfolio_valuation.md" />
        <FileRef path="notes/desk.md" icon />
      </div>
      <div className="flex flex-wrap items-center gap-2 rounded-xl bg-surface p-6">
        <FileRef path="portfolio_valuation.md" tone="paper" />
        <FileRef path="notes/desk.md" tone="paper" icon />
      </div>
    </div>
  ),
};

export const LongPath: Story = {
  render: () => (
    <div className="flex w-64 rounded-xl bg-paper p-6">
      <FileRef path="research/degen-projects/2026-09-26/scout-watch-pass.md" icon />
    </div>
  ),
};
