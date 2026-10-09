import type { Meta, StoryObj } from "@storybook/react-vite";
import { VersionBar } from "./VersionBar";

const meta: Meta<typeof VersionBar> = {
  title: "Components/Data/VersionBar",
  component: VersionBar,
  decorators: [
    (Story) => (
      <div className="flex flex-col gap-3 rounded-xl bg-surface p-6">
        <Story />
      </div>
    ),
  ],
};
export default meta;

type Story = StoryObj<typeof VersionBar>;

export const ByRun: Story = {
  args: {
    version: 63,
    when: "31m ago",
    actor: { kind: "run", runId: "r_01M3EVCWQ4GQ2T", trigger: "schedule wake-up", tool: "memory_write" },
    onOpenStep: () => {},
    onHistory: () => {},
  },
};

export const Actors: Story = {
  render: () => (
    <>
      <VersionBar
        version={12}
        when="2h ago"
        actor={{ kind: "run", runId: "r_01M3EQ2K7ZC1PB", trigger: "group delivery", tool: "note_write" }}
        onOpenStep={() => {}}
        onHistory={() => {}}
      />
      <VersionBar version={4} when="1d ago" actor={{ kind: "agent", name: "researchoor" }} onHistory={() => {}} />
      <VersionBar version={1} when="3d ago" actor={{ kind: "user", name: "Emma Martin" }} />
    </>
  ),
};

export const Narrow: Story = {
  render: () => (
    <div className="w-80">
      <VersionBar
        version={63}
        when="31m ago"
        actor={{ kind: "run", runId: "r_01M3EVCWQ4GQ2T", trigger: "schedule wake-up", tool: "memory_write" }}
        onOpenStep={() => {}}
        onHistory={() => {}}
      />
    </div>
  ),
};
