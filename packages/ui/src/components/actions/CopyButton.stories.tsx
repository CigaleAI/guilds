import type { Meta, StoryObj } from "@storybook/react-vite";
import { CopyButton } from "./CopyButton";

const meta: Meta<typeof CopyButton> = {
  title: "Components/Actions/CopyButton",
  component: CopyButton,
  args: { text: '{"query": "solana memecoins"}', what: "arguments" },
};
export default meta;

type Story = StoryObj<typeof CopyButton>;

export const Playground: Story = {};
