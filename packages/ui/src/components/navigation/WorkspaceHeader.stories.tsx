import type { Meta, StoryObj } from "@storybook/react-vite";
import { Archive, ArrowLeft, Check, KeyRound, Plus, Rocket } from "lucide-react";
import { Button } from "../actions/Button";
import { Icon } from "../../primitives/Icon";
import { WorkspaceHeader } from "./WorkspaceHeader";

const meta: Meta<typeof WorkspaceHeader> = {
  title: "Components/Navigation/WorkspaceHeader",
  component: WorkspaceHeader,
  parameters: { layout: "fullscreen" },
};
export default meta;

type Story = StoryObj<typeof WorkspaceHeader>;

const actions = (
  <>
    <Button variant="on-panel" size="sm">
      <Icon icon={ArrowLeft} size={14} />
      Back to guild
    </Button>
    <Button variant="on-panel" size="sm">
      <Icon icon={KeyRound} size={14} />
      Logins · 1 granted
    </Button>
    <Button variant="on-panel" size="sm">
      <Icon icon={Plus} size={14} />
      New session
    </Button>
    <Button variant="on-panel" size="sm">
      <Icon icon={Archive} size={14} />
      Archive
    </Button>
  </>
);

export const Studio: Story = {
  args: {
    eyebrow: "Studio",
    title: "degen-capital",
    meta: "coach · openrouter/openai/gpt-5.6-sol · temp 0.2",
    status: { label: "active · idle", live: true },
    actions,
  },
};

export const ArchivedStudio: Story = {
  args: {
    eyebrow: "Studio",
    title: "x-replies",
    meta: "coach · deepinfra/zai-org/GLM-5.3-Flash · temp 0.2",
    status: { label: "archived", live: false },
    actions: (
      <Button variant="on-panel" size="sm">
        <Icon icon={ArrowLeft} size={14} />
        Back to guild
      </Button>
    ),
  },
};

export const Builder: Story = {
  args: {
    eyebrow: "Builder",
    title: "Degen desk",
    meta: "body v4",
    status: { label: "draft · coach designing…", live: true },
    actions: (
      <>
        <Button variant="on-panel" size="sm">
          <Icon icon={ArrowLeft} size={14} />
          Builder
        </Button>
        <Button variant="on-panel" size="sm">
          <Icon icon={Check} size={14} />
          Approve
        </Button>
        <Button variant="accent" size="sm">
          <Icon icon={Rocket} size={14} />
          Deploy guild
        </Button>
      </>
    ),
  },
};
