import type { Meta, StoryObj } from "@storybook/react-vite";
import { useState } from "react";
import { Toggle } from "./Toggle";

const meta: Meta<typeof Toggle> = { title: "Components/Controls/Toggle", component: Toggle };
export default meta;

type Story = StoryObj<typeof Toggle>;

function Controlled({ initial, ...props }: { initial: boolean } & Parameters<typeof Toggle>[0]) {
  const [checked, setChecked] = useState(initial);
  return <Toggle checked={checked} onCheckedChange={setChecked} {...props} />;
}

export const States: Story = {
  render: () => (
    <div className="flex flex-wrap items-center gap-6 rounded-xl bg-surface p-6">
      <Controlled initial label="Auto-retry" />
      <Controlled initial={false} label="Auto-retry" />
      <Controlled initial aria-label="Browser" />
      <Toggle defaultChecked disabled label="Routines" />
      <Toggle disabled label="Browser" />
    </div>
  ),
};

export const WithDescription: Story = {
  render: () => (
    <div className="flex max-w-lg flex-col gap-5 rounded-xl bg-surface p-6">
      <Controlled
        initial
        label="Routines"
        description="Cron wake-ups in this guild fire on schedule. Turn this off to hold every routine."
      />
      <Controlled
        initial={false}
        label="Private"
        description="Only this guild's operators can see it. Other people in the organisation cannot."
      />
      <Controlled
        initial
        label="Browser"
        description="skyzo gets a live browser session on its next wake."
      />
    </div>
  ),
};
