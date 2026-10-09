import type { Meta, StoryObj } from "@storybook/react-vite";
import { StatusBadge } from "./StatusBadge";

const meta: Meta<typeof StatusBadge> = {
  title: "Components/Identity/StatusBadge",
  component: StatusBadge,
  args: { status: "running" },
  decorators: [
    (Story) => (
      <div className="flex flex-wrap items-center gap-2 rounded-xl bg-surface p-6">
        <Story />
      </div>
    ),
  ],
};
export default meta;

type Story = StoryObj<typeof StatusBadge>;

export const Playground: Story = {};

export const Statuses: Story = {
  render: () => (
    <>
      <StatusBadge status="running" />
      <StatusBadge status="ok" />
      <StatusBadge status="queued" />
      <StatusBadge status="failed" />
      <StatusBadge status="ok">completed</StatusBadge>
      <StatusBadge status="live" />
      <StatusBadge status="warning">Degraded</StatusBadge>
      <StatusBadge status="idle" />
    </>
  ),
};

export const OnPaper: Story = {
  render: () => (
    <div className="flex flex-wrap items-center gap-2 rounded-lg bg-paper p-4">
      <StatusBadge status="running" />
      <StatusBadge status="ok">completed</StatusBadge>
      <StatusBadge status="queued" />
      <StatusBadge status="failed">Out of budget</StatusBadge>
    </div>
  ),
};
