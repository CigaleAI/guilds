import type { Meta, StoryObj } from "@storybook/react-vite";
import { useState } from "react";
import { SearchField } from "./SearchField";

const meta: Meta<typeof SearchField> = {
  title: "Components/Controls/SearchField",
  component: SearchField,
};
export default meta;

type Story = StoryObj<typeof SearchField>;

function Demo({
  initial,
  ...props
}: {
  initial: string;
  placeholder: string;
  label: string;
  tone?: "paper" | "surface";
}) {
  const [value, setValue] = useState(initial);
  return <SearchField value={value} onValueChange={setValue} {...props} />;
}

export const Tones: Story = {
  render: () => (
    <div className="flex flex-col gap-4">
      <div className="flex max-w-sm flex-col gap-3 rounded-xl bg-surface p-6">
        <Demo initial="" label="Filter agents" placeholder="Filter agents…" />
        <Demo initial="note_" label="Filter tools" placeholder="Filter 12 tools…" />
      </div>
      <div className="flex max-w-sm flex-col gap-3 rounded-2xl bg-paper p-6">
        <Demo initial="" label="Search notes" placeholder="Search notes…" tone="surface" />
      </div>
    </div>
  ),
};
