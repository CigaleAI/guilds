import type { Meta, StoryObj } from "@storybook/react-vite";
import { Eye, Plus } from "lucide-react";
import { useState, type ReactNode } from "react";
import { Icon } from "../../primitives/Icon";
import { Button } from "../actions/Button";
import { IconButton } from "../actions/IconButton";
import { Checkbox } from "../controls/Checkbox";
import { Segmented } from "../controls/Segmented";
import { TextField } from "../controls/TextField";
import { Dialog, DialogBody, DialogClose, DialogContent, DialogFooter, DialogHeader, DialogTrigger } from "./Dialog";

const meta: Meta<typeof DialogContent> = {
  title: "Components/Overlays/Dialog",
  component: DialogContent,
  parameters: { layout: "fullscreen" },
};
export default meta;

type Story = StoryObj<typeof DialogContent>;

function Stage({ children }: { children: ReactNode }) {
  return <div className="flex h-screen flex-wrap items-start gap-2.5 p-6">{children}</div>;
}

function AddSecretDialog({ defaultOpen = false }: { defaultOpen?: boolean }) {
  const [reveal, setReveal] = useState(false);
  const [scope, setScope] = useState("guild");
  return (
    <Dialog defaultOpen={defaultOpen}>
      <DialogTrigger asChild>
        <Button>
          <Icon icon={Plus} size={14} />
          Add secret
        </Button>
      </DialogTrigger>
      <DialogContent size="sm">
        <DialogHeader title="Add secret" description="Available to every agent in Degen-capital" />
        <DialogBody>
          <TextField label="Name" tone="surface" mono defaultValue="WALLET_KEY" />
          <TextField
            label="Value"
            tone="surface"
            mono
            type={reveal ? "text" : "password"}
            defaultValue="0x9f3c1a7e5b2d"
            fieldClassName="pr-1.5"
            trail={
              <IconButton
                icon={Eye}
                label={reveal ? "Hide value" : "Show value"}
                variant="ghost"
                size={28}
                aria-pressed={reveal}
                onClick={() => setReveal(!reveal)}
              />
            }
          />
          <div className="flex flex-col gap-1.5">
            <span className="text-sm font-semibold">Scope</span>
            <Segmented
              label="Scope"
              value={scope}
              onValueChange={setScope}
              options={[
                { value: "guild", label: "Guild" },
                { value: "agent", label: "Agent" },
              ]}
            />
          </div>
        </DialogBody>
        <DialogFooter>
          <DialogClose asChild>
            <Button size="lg" variant="ghost">Cancel</Button>
          </DialogClose>
          <Button size="lg">Save secret</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export const AddSecret: Story = {
  render: () => (
    <Stage>
      <AddSecretDialog defaultOpen />
    </Stage>
  ),
};

const tools = [
  "note_find",
  "note_get",
  "note_write",
  "note_delete",
  "memory_write",
  "record_list",
  "record_search",
  "record_add",
  "record_update",
  "record_remove",
  "schedule_list",
  "schedule_create_cron",
  "schedule_create_window",
  "schedule_pause",
  "schedule_resume",
  "schedule_delete",
  "script_list",
  "script_read",
  "script_create",
  "script_run",
  "script_delete",
  "group_post",
  "report_issue",
  "tavily_search",
];

export const ScrollingBody: Story = {
  render: () => (
    <Stage>
      <Dialog defaultOpen>
        <DialogTrigger asChild>
          <Button variant="outline">Choose tools</Button>
        </DialogTrigger>
        <DialogContent size="md">
          <DialogHeader title="Tools for researchoor" description={`${tools.length} offered`} />
          <DialogBody className="gap-0">
            {tools.map((tool, index) => (
              <Checkbox
                key={tool}
                label={<span className="font-mono text-sm">{tool}</span>}
                defaultChecked={index % 3 !== 2}
              />
            ))}
          </DialogBody>
          <DialogFooter>
            <DialogClose asChild>
              <Button size="lg" variant="ghost">Cancel</Button>
            </DialogClose>
            <Button size="lg">Save tools</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Stage>
  ),
};

export const Sizes: Story = {
  render: () => (
    <Stage>
      {(["sm", "md", "lg"] as const).map((size) => (
        <Dialog key={size}>
          <DialogTrigger asChild>
            <Button variant="outline">Open {size}</Button>
          </DialogTrigger>
          <DialogContent size={size}>
            <DialogHeader title="Rename guild" description={`Dialog size ${size}`} />
            <DialogBody>
              <TextField aria-label="Guild name" tone="surface" defaultValue="Degen-capital" />
            </DialogBody>
            <DialogFooter>
              <DialogClose asChild>
                <Button size="lg" variant="ghost">Cancel</Button>
              </DialogClose>
              <Button size="lg">Rename</Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      ))}
    </Stage>
  ),
};
