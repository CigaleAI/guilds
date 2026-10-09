import type { Meta, StoryObj } from "@storybook/react-vite";
import { useState } from "react";
import { Slider } from "./Slider";

const meta: Meta<typeof Slider> = {
  title: "Components/Controls/Slider",
  component: Slider,
  decorators: [
    (Story) => (
      <div className="flex max-w-md flex-col gap-5 rounded-xl bg-surface p-6">
        <Story />
      </div>
    ),
  ],
};
export default meta;

type Story = StoryObj<typeof Slider>;

function Temperature({ initial }: { initial: number }) {
  const [value, setValue] = useState(initial);
  return (
    <Slider label="Temperature" min={0} max={2} step={0.1} value={value} onValueChange={setValue} />
  );
}

export const TemperatureRange: Story = {
  render: () => (
    <>
      <Temperature initial={0.2} />
      <Slider
        label="Temperature"
        min={0}
        max={2}
        step={0.1}
        defaultValue={1.3}
      />
    </>
  ),
};

export const Disabled: Story = {
  render: () => (
    <Slider
      label="Temperature"
      min={0}
      max={2}
      step={0.1}
      defaultValue={1}
      disabled
      hint="openrouter/openai/gpt-5.6-sol runs at a fixed temperature."
    />
  ),
};
