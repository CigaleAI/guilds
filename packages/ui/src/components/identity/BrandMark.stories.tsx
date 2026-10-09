import type { Meta, StoryObj } from "@storybook/react-vite";
import { BrandMark } from "./BrandMark";

const meta: Meta<typeof BrandMark> = {
  title: "Components/Identity/BrandMark",
  component: BrandMark,
  args: { size: 48, wordmark: false, appIcon: false },
  decorators: [
    (Story) => (
      <div className="flex flex-wrap items-center gap-5 rounded-xl bg-surface p-6">
        <Story />
      </div>
    ),
  ],
};
export default meta;

type Story = StoryObj<typeof BrandMark>;

export const Playground: Story = {};

export const Lockups: Story = {
  render: () => (
    <>
      <BrandMark size={48} />
      <BrandMark size={48} wordmark />
      <BrandMark size={28} appIcon />
    </>
  ),
};

export const Sizes: Story = {
  render: () => (
    <>
      <BrandMark size={28} />
      <BrandMark size={32} />
      <BrandMark size={48} />
      <BrandMark size={28} wordmark />
      <BrandMark size={32} wordmark />
    </>
  ),
};
