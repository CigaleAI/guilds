import type { Meta, StoryObj } from "@storybook/react-vite";
import { Copy, FileText, History, Maximize2, Pencil, Trash2 } from "lucide-react";
import { IconButton } from "../actions/IconButton";
import { Menu, MenuContent, MenuItem, MenuLabel, MenuSeparator, MenuTrigger } from "./Menu";

const meta: Meta<typeof MenuContent> = {
  title: "Components/Overlays/Menu",
  component: MenuContent,
  parameters: { layout: "fullscreen" },
};
export default meta;

type Story = StoryObj<typeof MenuContent>;

function AgentMenu({ defaultOpen = false }: { defaultOpen?: boolean }) {
  return (
    <Menu defaultOpen={defaultOpen} modal={false}>
      <MenuTrigger label="Agent options" variant="paper" />
      <MenuContent>
        <MenuItem icon={Pencil} shortcut="⌘R">
          Rename
        </MenuItem>
        <MenuItem icon={FileText}>Open prompt</MenuItem>
        <MenuItem icon={History}>View history</MenuItem>
        <MenuSeparator />
        <MenuItem icon={Copy}>Copy agent id</MenuItem>
        <MenuSeparator />
        <MenuItem icon={Trash2} destructive>
          Delete agent
        </MenuItem>
      </MenuContent>
    </Menu>
  );
}

export const AgentOptions: Story = {
  render: () => (
    <div className="flex h-110 justify-end p-6">
      <div className="flex h-fit gap-1.5 rounded-xl bg-surface p-5 pl-80">
        <IconButton icon={Maximize2} label="Expand" variant="paper" />
        <AgentMenu defaultOpen />
      </div>
    </div>
  ),
};

export const WithLabelsAndDisabled: Story = {
  render: () => (
    <div className="flex h-110 justify-end p-6">
      <div className="flex h-fit rounded-xl bg-surface p-5 pl-80">
        <Menu defaultOpen modal={false}>
          <MenuTrigger label="Record options" variant="paper" size={32} />
          <MenuContent>
            <MenuLabel>Record #118</MenuLabel>
            <MenuItem icon={Copy}>Copy as JSON</MenuItem>
            <MenuItem icon={Pencil} disabled>
              Edit record
            </MenuItem>
            <MenuSeparator />
            <MenuItem icon={Trash2} destructive>
              Delete record
            </MenuItem>
          </MenuContent>
        </Menu>
      </div>
    </div>
  ),
};

export const Closed: Story = {
  render: () => (
    <div className="flex p-6">
      <div className="flex gap-1.5 rounded-xl bg-surface p-5">
        <IconButton icon={Maximize2} label="Expand" variant="paper" />
        <AgentMenu />
      </div>
    </div>
  ),
};
