import type { Meta, StoryObj } from "@storybook/react-vite";
import { SidebarSection } from "./SidebarSection";

const meta: Meta<typeof SidebarSection> = {
  title: "Components/Navigation/SidebarSection",
  component: SidebarSection,
  args: { label: "Guilds", count: 4, addLabel: "Create guild", onAdd: () => {} },
  decorators: [
    (Story) => (
      <div className="w-75 rounded-xl bg-surface p-4">
        <Story />
      </div>
    ),
  ],
};
export default meta;

type Story = StoryObj<typeof SidebarSection>;

export const Playground: Story = {};

export const WithoutAction: Story = {
  render: () => <SidebarSection label="Guilds" count={0} />,
};
