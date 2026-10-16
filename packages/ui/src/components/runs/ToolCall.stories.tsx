import type { Meta, StoryObj } from "@storybook/react-vite";
import { useState } from "react";
import { JsonTree } from "../content/JsonTree";
import { Segmented } from "../controls/Segmented";
import { ToolCall, ToolCallLink, ToolCallTags, type ToolKind, type ToolLevel } from "./ToolCall";

const meta: Meta<typeof ToolCall> = {
  title: "Components/Runs/ToolCall",
  component: ToolCall,
  args: {
    name: "note_write",
    kind: "write",
    index: 1,
    hint: "Wrote retro_template.md",
    effect: "wrote",
    status: "ok",
    duration: "22ms",
  },
};
export default meta;

type Story = StoryObj<typeof ToolCall>;

/** How the app opens a call: its views, with the kind and level it touched on the right. */
function CallDetail({ value, kind, level }: { value: unknown; kind: ToolKind; level: ToolLevel }) {
  return (
    <div className="flex min-w-0 flex-col gap-2.5">
      <div className="flex flex-wrap items-center gap-2">
        <Segmented
          size="sm"
          label="details"
          value="arguments"
          onValueChange={() => {}}
          options={[
            { value: "arguments", label: "Arguments" },
            { value: "result", label: "Result" },
            { value: "metadata", label: "Metadata" },
          ]}
        />
        <span className="ml-auto">
          <ToolCallTags kind={kind} level={level} />
        </span>
      </div>
      <div className="max-h-48 overflow-auto rounded-md bg-surface p-3">
        <JsonTree value={value} />
      </div>
    </div>
  );
}

export const Playground: Story = {
  render: (args) => (
    <div className="max-w-xl rounded-xl bg-surface p-6">
      <ToolCall {...args} />
    </div>
  ),
};

/** A write carries **wrote** and a script run **ran script**; a write that touched a note, memory or script links to it. */
export const OkAndFailed: Story = {
  render: () => (
    <div className="flex max-w-xl flex-col gap-3 rounded-xl bg-surface p-6">
      <ToolCall
        index={1}
        name="note_write"
        kind="write"
        hint="Wrote retro_template.md"
        effect="wrote"
        status="ok"
        duration="22ms"
        link={<ToolCallLink href="#">retro_template.md</ToolCallLink>}
        onClick={() => {}}
      />
      <ToolCall
        index={2}
        name="schedule_create_cron"
        kind="write"
        hint="cron 0 0 * * *"
        status="failed"
        error="schedule already exists for this agent"
        duration="190ms"
      />
      <ToolCall
        name="script_run"
        kind="execute"
        hint="Run rebalance.py"
        effect="ran"
        status="running"
      />
    </div>
  ),
};

const kinds: Array<{ kind: ToolKind; name: string; hint: string; server?: string }> = [
  { kind: "read", name: "note_find", hint: "Find notes treasury" },
  { kind: "write", name: "record_add", hint: "Add to degen-orders" },
  { kind: "memory", name: "memory_write", hint: "Write memory" },
  { kind: "execute", name: "shell", hint: "git ls-remote origin" },
  { kind: "act", name: "browser_click", hint: "Click element" },
  { kind: "post", name: "group_post", hint: "Post to group" },
  { kind: "connected", name: "search_top_posts", hint: "query: memecoin", server: "x-api" },
  { kind: "unknown", name: "legacy_lookup", hint: "" },
];

export const Kinds: Story = {
  render: () => (
    <div className="flex max-w-xl flex-col gap-2 rounded-xl bg-surface p-6">
      {kinds.map((call) => (
        <ToolCall
          key={call.kind}
          name={call.name}
          kind={call.kind}
          server={call.server ?? null}
          hint={call.hint}
          status="ok"
          duration="14ms"
        />
      ))}
    </div>
  ),
};

function Selectable() {
  const [open, setOpen] = useState(true);
  return (
    <ToolCall
      name="shell"
      kind="execute"
      hint="git ls-remote origin"
      status="ok"
      duration="1.5s"
      expanded={open}
      detail={
        open ? (
          <CallDetail
            kind="execute"
            level="local"
            value={{ command: "git ls-remote git@example.com:acme/landing.git" }}
          />
        ) : undefined
      }
      onClick={() => setOpen(!open)}
    />
  );
}

export const Interactive: Story = {
  render: () => (
    <div className="flex max-w-xl flex-col gap-3 rounded-xl bg-surface p-6">
      <Selectable />
      <ToolCall
        name="note_find"
        kind="read"
        hint="Find notes…"
        status="ok"
        duration="14ms"
        dimmed
      />
    </div>
  ),
};
