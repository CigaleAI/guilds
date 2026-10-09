import type { Meta, StoryObj } from "@storybook/react-vite";
import { Checkbox } from "./Checkbox";
import { RadioGroup } from "./RadioGroup";

const meta: Meta<typeof Checkbox> = { title: "Components/Controls/Checkbox and radio", component: Checkbox };
export default meta;

type Story = StoryObj<typeof Checkbox>;

export const States: Story = {
  render: () => (
    <div className="grid max-w-md grid-cols-2 gap-x-3 rounded-xl bg-surface p-6">
      <div className="flex flex-col">
        <Checkbox label="Browser" />
        <Checkbox label="Routines on" defaultChecked />
        <Checkbox label="3 of 5 tools" checked="indeterminate" />
        <Checkbox label="Disabled" disabled />
        <Checkbox aria-label="Select degen-meta" />
      </div>
      <RadioGroup
        defaultValue="cron"
        aria-label="Schedule"
        options={[
          { value: "cron", label: "Cron (UTC)" },
          { value: "window", label: "Random window" },
          { value: "off", label: "Unavailable", disabled: true },
        ]}
      />
    </div>
  ),
};
