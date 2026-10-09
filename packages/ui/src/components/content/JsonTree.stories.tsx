import type { Meta, StoryObj } from "@storybook/react-vite";
import { JsonTree } from "./JsonTree";

const meta: Meta<typeof JsonTree> = {
  title: "Components/Content/JsonTree",
  component: JsonTree,
  args: {
    value: {
      query: "solana memecoins",
      limit: 20,
      include_replies: false,
      results: [
        { id: "tw_1", text: "gm", likes: 12 },
        {
          id: "tw_2",
          text: "x".repeat(400),
          likes: 3,
          author: { handle: "degen", followers: 1200 },
        },
      ],
      cursor: null,
    },
  },
};
export default meta;

type Story = StoryObj<typeof JsonTree>;

export const Playground: Story = {
  render: (args) => (
    <div className="max-w-xl rounded-lg bg-surface p-4">
      <JsonTree {...args} />
    </div>
  ),
};
