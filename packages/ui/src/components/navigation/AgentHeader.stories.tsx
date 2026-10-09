import type { Meta, StoryObj } from "@storybook/react-vite";
import { Ellipsis, Maximize2, X } from "lucide-react";
import { IconButton } from "../actions/IconButton";
import { AgentHeader } from "./AgentHeader";

const actions = (
  <>
    <IconButton icon={Maximize2} label="Full view" variant="surface" />
    <IconButton icon={Ellipsis} label="Agent options" variant="surface" />
    <IconButton icon={X} label="Close" variant="ink" />
  </>
);

const meta: Meta<typeof AgentHeader> = {
  title: "Components/Navigation/AgentHeader",
  component: AgentHeader,
  args: {
    name: "managooor",
    tone: "rosewood",
    state: "idle",
    focus: "Head of the degen fund. Moon or rekt, it's on you.",
    actions,
  },
  decorators: [
    (Story) => (
      <div className="rounded-3xl bg-dusk p-10">
        <div className="overflow-hidden rounded-2xl bg-paper shadow-modal">
          <Story />
        </div>
      </div>
    ),
  ],
};
export default meta;

type Story = StoryObj<typeof AgentHeader>;

export const Idle: Story = {};

export const Running: Story = {
  args: {
    name: "skyzo",
    tone: "signal",
    state: "running",
    focus: "One scout. Terminally online. Hunts metas, projects and mints.",
  },
};

/** While the inspector loads the agent's live state. */
export const Connecting: Story = {
  args: {
    name: "wallet",
    tone: "tide",
    state: "connecting",
    focus: "Hourly treasury: balances, gas and holdings across chains.",
  },
};

/** Without a focus the header stays one line. */
export const NoFocus: Story = {
  args: { name: "researchoor", tone: "moss", focus: undefined },
};

/** Below the md breakpoint. */
export const Compact: Story = {
  args: { compact: true },
};
