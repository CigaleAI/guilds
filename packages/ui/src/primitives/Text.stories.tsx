import type { Meta, StoryObj } from "@storybook/react-vite";
import { Text } from "./Text";

const meta: Meta<typeof Text> = {
  title: "Primitives/Text",
  component: Text,
  args: { variant: "body", children: "Fund stays flat until wallet credentials recover." },
};
export default meta;

type Story = StoryObj<typeof Text>;

export const Playground: Story = {};

export const Styles: Story = {
  render: () => (
    <div className="flex max-w-lg flex-col gap-3 rounded-xl bg-surface p-6">
      <Text variant="display">73K</Text>
      <Text variant="hero">128</Text>
      <Text variant="h1">Degen-capital</Text>
      <Text variant="h2">Guild overview</Text>
      <Text variant="title">Offered tools</Text>
      <Text variant="body">Fund stays flat until data recovers.</Text>
      <Text variant="caption">Active via guild · connected</Text>
      <Text variant="label">Guilds</Text>
      <Text variant="code">note_find</Text>
      <Text variant="meta">run_8f2c · 1.2s</Text>
    </div>
  ),
};

export const Tones: Story = {
  render: () => (
    <div className="flex flex-col gap-1 rounded-xl bg-surface p-6">
      {(["fg", "secondary", "muted", "faint", "accent", "success", "danger"] as const).map((tone) => (
        <Text key={tone} tone={tone}>
          {tone}
        </Text>
      ))}
    </div>
  ),
};
