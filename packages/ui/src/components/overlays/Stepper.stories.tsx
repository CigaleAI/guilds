import type { Meta, StoryObj } from "@storybook/react-vite";
import { useState } from "react";
import { ArrowLeft, ArrowRight, Info, Pencil, Plus, X } from "lucide-react";
import { Avatar } from "../identity/Avatar";
import { Icon } from "../../primitives/Icon";
import type { IdentityTone } from "../../identity";
import { Button } from "../actions/Button";
import { IconButton } from "../actions/IconButton";
import { Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader, DialogTrigger } from "./Dialog";
import { Stepper } from "./Stepper";

const meta: Meta<typeof Stepper> = {
  title: "Components/Overlays/Stepper",
  component: Stepper,
  args: { steps: ["Basics", "Agents", "Tools & secrets", "Review"], current: 1 },
};
export default meta;

type Story = StoryObj<typeof Stepper>;

export const Playground: Story = {
  render: (args) => (
    <div className="rounded-xl bg-paper p-6">
      <Stepper {...args} />
    </div>
  ),
};

export const Progress: Story = {
  render: (args) => (
    <div className="flex flex-col gap-6 rounded-xl bg-paper p-6">
      {[0, 1, 2, 3].map((current) => (
        <Stepper key={current} steps={args.steps} current={current} />
      ))}
    </div>
  ),
};

/** Steps as sections, opened in any order, one of them flagged. */
export const Sections: Story = {
  render: function Render(args) {
    const [current, setCurrent] = useState(0);
    return (
      <div className="rounded-xl bg-paper p-6">
        <Stepper steps={args.steps} current={current} onSelect={setCurrent} flagged={[2]} />
      </div>
    );
  },
};

const agents: { name: string; initials: string; tone: IdentityTone; meta: string }[] = [
  { name: "skyzo", initials: "SK", tone: "signal", meta: "Scout · gpt-5.6-mini · 3 tools" },
  { name: "researchoor", initials: "RS", tone: "moss", meta: "Researcher · claude-sonnet · 5 tools" },
  { name: "managooor", initials: "MG", tone: "rosewood", meta: "Manager · gpt-5.6-sol · 4 tools" },
];

export const InCreateGuildDialog: Story = {
  parameters: { layout: "fullscreen" },
  render: (args) => (
    <div className="h-screen p-6">
      <Dialog defaultOpen>
        <DialogTrigger asChild>
          <Button>New guild</Button>
        </DialogTrigger>
        <DialogContent size="lg">
          <DialogHeader title="Create a guild" description="Step 2 of 4 · Agents" />
          <Stepper steps={args.steps} current={1} className="px-6 pt-4" />
          <DialogBody>
            <div className="flex items-center gap-2">
              <span className="text-md font-semibold">Agents</span>
              <span className="ml-auto type-meta text-muted">3 of 15 agents</span>
            </div>
            <div className="flex flex-col gap-1.5">
              {agents.map((agent) => (
                <div key={agent.name} className="flex items-center gap-3 rounded-md bg-surface px-3 py-2.5">
                  <Avatar name={agent.name} initials={agent.initials} tone={agent.tone} />
                  <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <span className="truncate font-mono text-sm font-medium">{agent.name}</span>
                    <span className="truncate text-xs text-muted">{agent.meta}</span>
                  </div>
                  <IconButton icon={Pencil} label={`Edit ${agent.name}`} variant="ghost" size={32} />
                  <IconButton icon={X} label={`Remove ${agent.name}`} variant="ghost" size={32} />
                </div>
              ))}
              <button
                type="button"
                className="flex cursor-pointer items-center gap-3 rounded-md px-3 py-2.5 text-left inset-ring-[1.5px] inset-ring-rule hover:bg-surface"
              >
                <span className="flex size-9 items-center justify-center">
                  <Icon icon={Plus} />
                </span>
                <span className="flex flex-col gap-0.5">
                  <span className="text-sm font-semibold">Add agent</span>
                  <span className="text-xs text-muted">Blank, or start from a role</span>
                </span>
              </button>
            </div>
            <p className="flex items-center gap-2 text-sm text-muted">
              <Icon icon={Info} size={14} />
              Agents can be renamed and re-prompted after the guild is created.
            </p>
          </DialogBody>
          <DialogFooter>
            <Button size="lg" variant="ghost" className="mr-auto">
              <Icon icon={ArrowLeft} size={14} />
              Back
            </Button>
            <Button size="lg">
              Continue
              <Icon icon={ArrowRight} size={14} />
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  ),
};
