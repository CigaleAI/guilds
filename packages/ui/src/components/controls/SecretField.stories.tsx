import type { Meta, StoryObj } from "@storybook/react-vite";
import { useState } from "react";
import { SecretField } from "./SecretField";

const meta: Meta<typeof SecretField> = {
  title: "Components/Controls/SecretField",
  component: SecretField,
  decorators: [
    (Story) => (
      <div className="flex max-w-md flex-col gap-5 rounded-xl bg-surface p-6">
        <Story />
      </div>
    ),
  ],
};
export default meta;

type Story = StoryObj<typeof SecretField>;

function Typed() {
  const [value, setValue] = useState("sk-live-4f9a2c");
  return (
    <SecretField
      label="Value"
      tone="surface"
      value={value}
      onChange={(event) => setValue(event.currentTarget.value)}
      hint="Agents read it as an environment variable."
    />
  );
}

export const Basic: Story = { render: () => <Typed /> };

export const Invalid: Story = {
  render: () => <SecretField label="Value" defaultValue="" error="A value is required" />,
};
