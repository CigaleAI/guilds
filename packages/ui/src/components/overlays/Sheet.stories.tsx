import type { Meta, StoryObj } from "@storybook/react-vite";
import { ChevronDown, FileText, History, Maximize2, Minimize2, Trash2, X } from "lucide-react";
import { useState } from "react";
import { Dot } from "../../primitives/Dot";
import { Icon } from "../../primitives/Icon";
import { Pill } from "../../primitives/Pill";
import { Tag } from "../../primitives/Tag";
import { Button } from "../actions/Button";
import { IconButton } from "../actions/IconButton";
import { Tabs, TabsList, TabsTrigger } from "../controls/Tabs";
import { Avatar } from "../identity/Avatar";
import { Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger } from "./Menu";
import {
  Sheet,
  SheetBody,
  SheetClose,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "./Sheet";

const meta: Meta<typeof SheetContent> = {
  title: "Components/Overlays/Sheet",
  component: SheetContent,
  parameters: { layout: "fullscreen" },
};
export default meta;

type Story = StoryObj<typeof SheetContent>;

const tabs = ["Chat", "Prompt", "History", "Routine", "Scripts", "Notes", "Tables", "Tools", "Secrets", "Usage"];
const tools = ["note_find", "note_get", "note_write", "note_delete", "schedule_list"];

function AgentInspector({ defaultExpanded = false }: { defaultExpanded?: boolean }) {
  const [expanded, setExpanded] = useState(defaultExpanded);
  const [tab, setTab] = useState("Chat");
  return (
    <Sheet defaultOpen>
      <SheetTrigger asChild>
        <Button>Open managooor</Button>
      </SheetTrigger>
      <SheetContent expanded={expanded}>
        <SheetHeader>
          <Avatar name="managooor" initials="MG" tone="rosewood" size={64} />
          <div className="flex min-w-0 flex-1 flex-col gap-1 pt-1.5">
            <div className="flex items-baseline gap-2.5">
              <SheetTitle className="truncate font-mono text-2xl font-medium">managooor</SheetTitle>
              <span className="flex items-center gap-1 type-meta text-muted">
                <Dot size="sm" tone="idle" />
                idle
              </span>
            </div>
            <SheetDescription className="text-md text-fg-2">
              Head of the degen fund. Moon or rekt, it’s on you.
            </SheetDescription>
          </div>
          <div className="flex gap-1.5">
            <IconButton
              icon={expanded ? Minimize2 : Maximize2}
              label={expanded ? "Restore size" : "Expand"}
              variant="surface"
              onClick={() => setExpanded(!expanded)}
            />
            <Menu modal={false}>
              <MenuTrigger label="Agent options" variant="surface" />
              <MenuContent>
                <MenuItem icon={FileText}>Open prompt</MenuItem>
                <MenuItem icon={History}>View history</MenuItem>
                <MenuSeparator />
                <MenuItem icon={Trash2} destructive>
                  Delete agent
                </MenuItem>
              </MenuContent>
            </Menu>
            <SheetClose asChild>
              <IconButton icon={X} label="Close" variant="ink" />
            </SheetClose>
          </div>
        </SheetHeader>
        <Tabs value={tab} onValueChange={setTab}>
          <TabsList look="bar" aria-label="Agent sections">
            {tabs.map((label) => (
              <TabsTrigger key={label} value={label}>
                {label}
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
        <SheetBody>
          <div className="mx-auto flex w-full max-w-240 flex-col gap-3">
            <div className="flex flex-wrap items-center gap-2.5 rounded-xl bg-surface px-4 py-3">
              <span className="text-md font-bold">Offered tools</span>
              <Pill size="xs" fill="accent">
                54 available
              </Pill>
              {tools.map((tool) => (
                <Tag key={tool} className="text-xs">
                  {tool}
                </Tag>
              ))}
              <span className="text-xs text-muted">+49 more</span>
              <Icon icon={ChevronDown} size={14} className="ml-auto" />
            </div>
            {Array.from({ length: 8 }, (_, index) => (
              <div key={index} className="rounded-xl bg-surface px-4 py-3 text-md text-fg-2">
                {index % 2 === 0
                  ? "Every 24h, do a retrospective of the day. Ask researchoor to check the status of previously closed calls and fold the learnings into the fund thesis."
                  : "Checked 6 open positions against the thesis. Two moved past their stop; flagged both to wallet for exit."}
              </div>
            ))}
          </div>
        </SheetBody>
      </SheetContent>
    </Sheet>
  );
}

export const AgentInspectorSheet: Story = {
  name: "Agent inspector",
  render: () => (
    <div className="h-screen p-6">
      <AgentInspector />
    </div>
  ),
};

export const Expanded: Story = {
  render: () => (
    <div className="h-screen p-6">
      <AgentInspector defaultExpanded />
    </div>
  ),
};
