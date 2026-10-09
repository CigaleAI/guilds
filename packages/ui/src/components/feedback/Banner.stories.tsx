import type { Meta, StoryObj } from "@storybook/react-vite";
import { RefreshCw } from "lucide-react";
import { useState } from "react";
import { Icon } from "../../primitives/Icon";
import { Button } from "../actions/Button";
import { Banner } from "./Banner";

const meta: Meta<typeof Banner> = {
  title: "Components/Feedback/Banner",
  component: Banner,
  args: { tone: "error", title: "Couldn’t load records", meta: "ERR_DB_TIMEOUT · 12s" },
};
export default meta;

type Story = StoryObj<typeof Banner>;

const retry = (
  <Button variant="outline" size="sm">
    <Icon icon={RefreshCw} size={14} />
    Retry
  </Button>
);

export const Playground: Story = {
  render: (args) => (
    <div className="max-w-xl rounded-xl bg-surface p-5">
      <Banner {...args} action={retry} />
    </div>
  ),
};

export const Tones: Story = {
  render: () => (
    <div className="flex max-w-xl flex-col gap-3 rounded-xl bg-surface p-5">
      <Banner tone="error" title="Couldn’t load records" meta="ERR_DB_TIMEOUT · 12s" action={retry} />
      <Banner tone="warning" title="Agent limit almost reached" meta="13 of 15 agents · raise it in Settings" />
      <Banner tone="info" title="researchoor is running" meta="run r_01M3EQ2K · started 21:40" />
      <Banner tone="success" title="Recipe applied" meta="4 agents · 2 routines · 1 database" />
    </div>
  ),
};

export const Narrow: Story = {
  render: () => (
    <div className="flex w-75 flex-col gap-3 rounded-xl bg-surface p-5">
      <Banner tone="error" title="Couldn’t load records" meta="ERR_DB_TIMEOUT · 12s" action={retry} />
      <Banner tone="warning" title="coingecko is unreachable" meta="MCP · 401 since 21:40" />
    </div>
  ),
};

function DismissableBanner() {
  const [open, setOpen] = useState(true);
  return (
    <div className="max-w-xl rounded-xl bg-surface p-5">
      {open ? (
        <Banner tone="info" title="Tools are inherited" onDismiss={() => setOpen(false)}>
          researchoor uses the guild’s tools unless you switch one off here.
        </Banner>
      ) : (
        <Button variant="outline" onClick={() => setOpen(true)}>
          Show banner
        </Button>
      )}
    </div>
  );
}

export const WithBodyAndDismiss: Story = {
  render: () => <DismissableBanner />,
};
