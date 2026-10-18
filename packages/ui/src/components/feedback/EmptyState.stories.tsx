import type { Meta, StoryObj } from "@storybook/react-vite";
import { Database, Plus, Repeat, SearchX } from "lucide-react";
import { Icon } from "../../primitives/Icon";
import { Button } from "../actions/Button";
import { EmptyState } from "./EmptyState";

const meta: Meta<typeof EmptyState> = {
  title: "Components/Feedback/Empty state",
  component: EmptyState,
  args: {
    icon: Repeat,
    title: "No routines yet",
    description: "Routines wake an agent on a schedule — an hourly treasury check, a daily retro.",
  },
};
export default meta;

type Story = StoryObj<typeof EmptyState>;

export const NoRoutines: Story = {
  render: (args) => (
    <div className="max-w-sm rounded-xl bg-surface p-5">
      <EmptyState
        {...args}
        action={
          <Button>
            <Icon icon={Plus} size={14} />
            New routine
          </Button>
        }
        secondaryAction={<Button variant="ghost">Browse recipes</Button>}
      />
    </div>
  ),
};

export const NoTables: Story = {
  render: () => (
    <div className="max-w-xl rounded-xl bg-surface p-5">
      <EmptyState
        icon={Database}
        title="No tables in Degen-capital"
        description="Agents keep records here — orders, leads, scores. Create one here; agents fill it with record_add."
        action={
          <Button>
            <Icon icon={Plus} size={14} />
            New table
          </Button>
        }
      />
    </div>
  ),
};

export const NoResults: Story = {
  render: () => (
    <div className="max-w-sm rounded-xl bg-surface p-5">
      <EmptyState
        icon={SearchX}
        title="No tools match “coingeko”"
        description="Check the spelling, or search by server name."
        secondaryAction={<Button variant="ghost">Clear search</Button>}
      />
    </div>
  ),
};
