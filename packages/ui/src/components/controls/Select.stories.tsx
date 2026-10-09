import type { Meta, StoryObj } from "@storybook/react-vite";
import { useState } from "react";
import { Select, type SelectOptionGroup } from "./Select";

const meta: Meta<typeof Select> = {
  title: "Components/Controls/Select",
  component: Select,
  decorators: [
    (Story) => (
      <div className="flex max-w-md flex-col gap-5 rounded-xl bg-surface p-6">
        <Story />
      </div>
    ),
  ],
};
export default meta;

type Story = StoryObj<typeof Select>;

const models: SelectOptionGroup[] = [
  {
    label: "OpenRouter",
    options: [
      {
        value: "openrouter/anthropic/claude-sonnet",
        label: "openrouter/anthropic/claude-sonnet",
        description: "Claude Sonnet",
      },
      {
        value: "openrouter/openai/gpt-5.6-sol",
        label: "openrouter/openai/gpt-5.6-sol",
        description: "GPT-5.6 Sol",
      },
    ],
  },
  {
    label: "DeepInfra",
    options: [
      {
        value: "deepinfra/zai-org/GLM-5.3-Flash",
        label: "deepinfra/zai-org/GLM-5.3-Flash",
        description: "GLM 5.3 Flash",
      },
    ],
  },
];

const thinking = [
  { value: "none", label: "None (Off)" },
  { value: "low", label: "Low" },
  { value: "medium", label: "Medium" },
  { value: "high", label: "High" },
];

const timezones = ["UTC", "Europe/Paris", "America/New_York", "Asia/Singapore"].map((value) => ({
  value,
  label: value,
}));

function ModelPicker() {
  const [model, setModel] = useState("openrouter/anthropic/claude-sonnet");
  return (
    <Select
      label="Model"
      mono
      options={models}
      value={model}
      onValueChange={setModel}
    />
  );
}

export const AgentModel: Story = {
  render: () => (
    <>
      <ModelPicker />
      <Select
        label="Thinking level"
        options={thinking}
        defaultValue="medium"
        hint="Reasoning effort for compatible models."
      />
      <Select label="Timezone" options={timezones} defaultValue="UTC" />
    </>
  ),
};

export const Open: Story = {
  // An open Select hides the rest of the page from assistive tech while focus sits in its list.
  parameters: { a11y: { config: { rules: [{ id: "aria-hidden-focus", enabled: false }] } } },
  render: () => (
    <div className="min-h-80">
      <Select
        label="Model"
        mono
        options={models}
        defaultValue="openrouter/openai/gpt-5.6-sol"
        defaultOpen
      />
    </div>
  ),
};

export const States: Story = {
  render: () => (
    <>
      <Select label="Timezone" options={timezones} placeholder="Pick a timezone" />
      <Select
        label="Thinking level"
        options={thinking}
        defaultValue="none"
        disabled
        hint="deepinfra/zai-org/GLM-5.3-Flash does not take a thinking level."
      />
      <Select
        label="Model"
        mono
        options={models}
        error="Pick a model this guild can use."
        placeholder="Pick a model"
      />
    </>
  ),
};
