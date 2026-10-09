import type { Meta, StoryObj } from "@storybook/react-vite";
import { Trash2 } from "lucide-react";
import type { ReactNode } from "react";
import { Icon } from "../../primitives/Icon";
import { Button } from "../actions/Button";
import { ConfirmDialog } from "./ConfirmDialog";

const meta: Meta<typeof ConfirmDialog> = {
  title: "Components/Overlays/Confirm dialog",
  component: ConfirmDialog,
  parameters: { layout: "fullscreen" },
};
export default meta;

type Story = StoryObj<typeof ConfirmDialog>;

function Stage({ children }: { children: ReactNode }) {
  return <div className="flex h-screen flex-wrap items-start gap-2.5 p-6">{children}</div>;
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export const Destructive: Story = {
  render: () => (
    <Stage>
      <ConfirmDialog
        defaultOpen
        kind="destructive"
        title="Delete degen-meta?"
        description="This removes 9 records and revokes access for 5 agents. It can’t be undone."
        confirmText="degen-meta"
        confirmLabel="Delete database"
        onConfirm={() => wait(800)}
        trigger={
          <Button variant="danger">
            <Icon icon={Trash2} size={14} />
            Delete database
          </Button>
        }
      />
    </Stage>
  ),
};

export const DestructiveWithoutTyping: Story = {
  render: () => (
    <Stage>
      <ConfirmDialog
        defaultOpen
        kind="destructive"
        title="Delete record #118?"
        description="It leaves degen-orders for good."
        confirmLabel="Delete record"
        trigger={<Button variant="danger">Delete record</Button>}
      />
    </Stage>
  ),
};

export const Confirm: Story = {
  render: () => (
    <Stage>
      <ConfirmDialog
        defaultOpen
        title="Restore v7?"
        description="fund-thesis.md goes back to v7, saved as a new version. Later versions stay in the history."
        confirmLabel="Restore v7"
        trigger={<Button variant="outline">Restore</Button>}
      />
    </Stage>
  ),
};

export const Alert: Story = {
  render: () => (
    <Stage>
      <ConfirmDialog
        defaultOpen
        kind="alert"
        title="Agent limit reached"
        description="Degen-capital is limited to 15 agents. Raise the limit on the Settings tab."
        trigger={<Button>New agent</Button>}
      />
    </Stage>
  ),
};
