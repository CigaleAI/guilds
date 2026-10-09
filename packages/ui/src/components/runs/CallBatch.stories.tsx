import type { Meta, StoryObj } from "@storybook/react-vite";
import { useState } from "react";
import { JsonTree } from "../content/JsonTree";
import { Segmented } from "../controls/Segmented";
import { CallBatch } from "./CallBatch";
import { ToolCall } from "./ToolCall";

const meta: Meta<typeof CallBatch> = {
  title: "Components/Runs/CallBatch",
  component: CallBatch,
};
export default meta;

type Story = StoryObj<typeof CallBatch>;

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

export const TwoCalls: Story = {
  render: () => (
    <div className="max-w-xl rounded-xl bg-surface p-6">
      <CallBatch count={2} duration="20ms">
        <ToolCall
          index={1}
          name="schedule_list"
          kind="read"
          level="local"
          hint="List schedules"
          status="ok"
          duration="6ms"
        />
        <ToolCall
          index={2}
          name="note_find"
          kind="read"
          level="guild"
          hint="Find notes…"
          status="ok"
          duration="14ms"
        />
      </CallBatch>
    </div>
  ),
};

export const TwoAbreast: Story = {
  render: () => (
    <div className="rounded-xl bg-surface p-6">
      <CallBatch count={3} duration="35ms">
        <ToolCall
          index={1}
          name="schedule_list"
          kind="read"
          level="local"
          hint="List schedules"
          status="ok"
          duration="6ms"
        />
        <ToolCall
          index={2}
          name="note_find"
          kind="read"
          level="guild"
          hint="Find notes…"
          status="ok"
          duration="14ms"
        />
        <ToolCall
          index={3}
          name="note_find"
          kind="read"
          level="local"
          hint="Find notes…"
          status="ok"
          duration="15ms"
        />
      </CallBatch>
    </div>
  ),
};

export const WithFailure: Story = {
  render: () => (
    <div className="rounded-xl bg-surface p-6">
      <CallBatch count={2} duration="212ms" failed={1}>
        <ToolCall
          index={1}
          name="schedule_create_cron"
          kind="write"
          level="local"
          hint="cron 0 0 * * *"
          status="failed"
          error="schedule already exists for this agent"
          duration="190ms"
        />
        <ToolCall
          index={2}
          name="note_write"
          kind="write"
          level="guild"
          hint="retro_template.md"
          status="ok"
          duration="22ms"
        />
      </CallBatch>
    </div>
  ),
};

function ExpandedBatch() {
  const [open, setOpen] = useState<string | null>("memory_write");
  const args = {
    group_post: { content: "Signaled @x-access in the guild chat." },
    memory_write: {
      rules: "Standing task: fetch top reply opportunities.",
      facts: "Queue x-replies-to-post now 61 records.",
      pending: "Next run: fetch fresh opportunities.",
    },
  } as const;
  return (
    <CallBatch count={2} duration="31ms">
      <ToolCall
        index={1}
        name="group_post"
        kind="post"
        level="guild"
        hint="Post to group"
        status="ok"
        duration="14ms"
        expanded={open === "group_post"}
        detail={open === "group_post" ? <CallDetail value={args.group_post} /> : undefined}
        onClick={() => setOpen((current) => (current === "group_post" ? null : "group_post"))}
      />
      <ToolCall
        index={2}
        name="memory_write"
        kind="memory"
        level="local"
        hint="Write memory"
        status="ok"
        duration="17ms"
        expanded={open === "memory_write"}
        detail={open === "memory_write" ? <CallDetail value={args.memory_write} /> : undefined}
        onClick={() => setOpen((current) => (current === "memory_write" ? null : "memory_write"))}
      />
    </CallBatch>
  );
}

export const Expanded: Story = {
  render: () => (
    <div className="rounded-xl bg-surface p-6">
      <ExpandedBatch />
    </div>
  ),
};
