import type { Meta, StoryObj } from "@storybook/react-vite";
import { useState } from "react";
import { JsonTree } from "../content/JsonTree";
import { Segmented } from "../controls/Segmented";
import { ToolCall, type ToolKind } from "./ToolCall";

const meta: Meta<typeof ToolCall> = {
  title: "Components/Runs/ToolCall",
  component: ToolCall,
  args: {
    name: "note_write",
    kind: "write",
    level: "guild",
    index: 1,
    hint: "retro_template.md",
    status: "ok",
    duration: "22ms",
  },
};
export default meta;

type Story = StoryObj<typeof ToolCall>;

function CallDetail({ value }: { value: unknown }) {
  return (
    <div className="flex min-w-0 flex-col gap-2.5">
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
      <div className="max-h-48 overflow-auto rounded-md bg-surface p-3">
        <JsonTree value={value} />
      </div>
    </div>
  );
}

export const Playground: Story = {
  render: (args) => (
    <div className="max-w-md rounded-xl bg-surface p-6">
      <ToolCall {...args} />
    </div>
  ),
};

export const OkAndFailed: Story = {
  render: () => (
    <div className="flex max-w-md flex-col gap-3 rounded-xl bg-surface p-6">
      <ToolCall
        index={1}
        name="note_write"
        kind="write"
        level="guild"
        hint="retro_template.md"
        status="ok"
        duration="22ms"
      />
      <ToolCall
        index={2}
        name="schedule_create_cron"
        kind="write"
        level="local"
        hint="cron 0 0 * * *"
        status="failed"
        error="schedule already exists for this agent"
        duration="190ms"
      />
      <ToolCall
        name="script_run"
        kind="execute"
        level="local"
        hint="Run rebalance.py"
        status="running"
      />
    </div>
  ),
};

const kinds: Array<{
  kind: ToolKind;
  name: string;
  hint: string;
  level?: "local" | "guild" | "org" | "all";
  server?: string;
}> = [
  { kind: "read", name: "note_find", hint: "Find notes treasury", level: "all" },
  { kind: "write", name: "record_add", hint: "Add to degen-orders", level: "org" },
  { kind: "memory", name: "memory_write", hint: "Write memory", level: "local" },
  { kind: "execute", name: "script_run", hint: "Run price_check.py", level: "local" },
  { kind: "act", name: "browser_click", hint: "Click element" },
  { kind: "post", name: "group_post", hint: "Post to group", level: "guild" },
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
          level={call.level ?? null}
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
      name="memory_write"
      kind="memory"
      level="local"
      hint="Write memory"
      status="ok"
      duration="17ms"
      expanded={open}
      detail={
        open ? (
          <CallDetail
            value={{
              rules: "Standing task: fetch top reply opportunities.",
              pending: "Next run: fetch fresh opportunities.",
            }}
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
        level="guild"
        hint="Find notes…"
        status="ok"
        duration="14ms"
        dimmed
      />
    </div>
  ),
};
