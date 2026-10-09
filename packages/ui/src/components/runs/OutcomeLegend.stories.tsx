import type { Meta, StoryObj } from "@storybook/react-vite";
import { OutcomeLegend } from "./OutcomeLegend";

const meta: Meta<typeof OutcomeLegend> = {
  title: "Components/Runs/OutcomeLegend",
  component: OutcomeLegend,
};
export default meta;

type Story = StoryObj<typeof OutcomeLegend>;

export const Default: Story = {
  render: () => (
    <div className="max-w-xl rounded-xl bg-surface p-6">
      <OutcomeLegend lead="Each wake:" />
    </div>
  ),
};
