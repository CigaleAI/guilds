import type { Meta, StoryObj } from "@storybook/react-vite";
import { FileX, RefreshCw } from "lucide-react";
import { Icon } from "../../primitives/Icon";
import { Button } from "../actions/Button";
import { PageError } from "./PageError";

const meta: Meta<typeof PageError> = {
  title: "Components/Feedback/Page error",
  component: PageError,
};
export default meta;

type Story = StoryObj<typeof PageError>;

export const ConnectionLost: Story = {
  render: () => (
    <div className="max-w-sm rounded-xl bg-surface p-5">
      <PageError
        title="Lost connection to the guild"
        description="Live updates paused. Drafts are safe."
        action={
          <Button>
            <Icon icon={RefreshCw} size={14} />
            Reconnect
          </Button>
        }
      />
    </div>
  ),
};

export const NotFound: Story = {
  render: () => (
    <div className="max-w-sm rounded-xl bg-surface p-5">
      <PageError
        icon={FileX}
        title="This note is gone"
        description="notes/fund-thesis.md was deleted or moved."
        action={<Button>Back to notes</Button>}
      />
    </div>
  ),
};
