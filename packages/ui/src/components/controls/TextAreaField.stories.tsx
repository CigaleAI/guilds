import type { Meta, StoryObj } from "@storybook/react-vite";
import { useState } from "react";
import { TextAreaField } from "./TextAreaField";

const meta: Meta<typeof TextAreaField> = {
  title: "Components/Controls/TextAreaField",
  component: TextAreaField,
  decorators: [
    (Story) => (
      <div className="flex max-w-xl flex-col gap-5 rounded-xl bg-surface p-6">
        <Story />
      </div>
    ),
  ],
};
export default meta;

type Story = StoryObj<typeof TextAreaField>;

const description = `# Degen Venture
Degen trading firm. Memecoins and NFTs. Hear it in the trenches, size it, fill it.

## Desk
One scout. Terminally online. Hunts metas, projects, mints and narratives.`;

function GuildDescription() {
  const [value, setValue] = useState(description);
  return (
    <TextAreaField
      label="Description"
      aside="Markdown"
      rows={8}
      value={value}
      onChange={(event) => setValue(event.currentTarget.value)}
      maxLength={8000}
      showCount
      hint="Agents see this on each run."
      placeholder="What this guild is for, how it should work, constraints"
    />
  );
}

export const MarkdownMono: Story = { render: () => <GuildDescription /> };

export const Sans: Story = {
  render: () => (
    <TextAreaField
      label="Description"
      font="sans"
      rows={2}
      defaultValue="Research projects, digest charts and report."
    />
  ),
};

export const Invalid: Story = {
  render: () => (
    <TextAreaField
      label="Short description"
      font="sans"
      rows={2}
      maxLength={200}
      showCount
      defaultValue=""
      error="A guild needs a short description."
      placeholder="High-level goal for everyone in this guild"
    />
  ),
};
