import type { Meta, StoryObj } from "@storybook/react-vite";
import { useState } from "react";
import { TaskEditor, type TaskEditorProps } from "./TaskEditor";

const meta: Meta<typeof TaskEditor> = {
  title: "Components/Content/TaskEditor",
  component: TaskEditor,
  parameters: { layout: "padded" },
};
export default meta;

type Story = StoryObj<typeof TaskEditor>;

const liveTask = `You run the degen fund. Moon or rekt, it's on you.

## Every hour
- Read the latest treasury report from wallet before sizing anything.
- Never size a trade without verified wallet balances.
- Orders go to ![[org/org_01j9x2k7/collections/degen-orders]] with status \`PENDING\`.
- Report hourly; stay silent when nothing changed.

## Every 24h
Run a retrospective with researchoor: check closed and exited calls, see how your decisions held up, and fold the learnings into ![[org/org_01j9x2k7/guilds/g_01j9x3m1/fund-thesis.md]], your memory and the scoring system.`;

const sizingRules = `

## Sizing
- Nascent: watch only.
- Mooning: size up to $1k.
- Fading: exit half, trail the rest.
- Never hold more than 25% of the fund in one token.
- Keep 0.05 ETH on every chain for gas.
- Ask researchoor for a score before any new position.
- Ignore calls from accounts younger than 30 days.
- Escalate to the operator when a single order exceeds $2,500.`;

const picked: Record<"note" | "table", string> = {
  note: "org/org_01j9x2k7/guilds/g_01j9x3m1/trench-rules.md",
  table: "org/org_01j9x2k7/collections/degen-projects",
};

function Editor({
  initial,
  saved,
  revision,
  ...props
}: Partial<TaskEditorProps> & { initial: string; saved: string; revision: number }) {
  const [value, setValue] = useState(initial);
  const [live, setLive] = useState(saved);
  const [version, setVersion] = useState(revision);
  return (
    <div className="rounded-xl bg-surface p-5">
      <TaskEditor
        value={value}
        onChange={setValue}
        savedValue={live}
        revision={version}
        onSave={() => {
          setLive(value);
          setVersion((current) => current + 1);
        }}
        onDiscard={() => setValue(live)}
        onPickEmbed={(kind) => picked[kind]}
        isBrokenEmbed={(path) => path.includes("trench-rules")}
        {...props}
      />
    </div>
  );
}

export const Editing: Story = {
  render: () => (
    <Editor
      initial={liveTask.replace(
        "Report hourly; stay silent when nothing changed.",
        "Report every hour, even when flat.",
      )}
      saved={liveTask}
      revision={8}
      tokenCount={412}
    />
  ),
};

export const Saved: Story = {
  render: () => <Editor initial={liveTask} saved={liveTask} revision={8} />,
};

export const Preview: Story = {
  render: () => (
    <Editor
      initial={liveTask}
      saved={liveTask}
      revision={8}
      tokenCount={412}
      defaultMode="preview"
    />
  ),
};

export const LongTask: Story = {
  render: () => (
    <Editor
      initial={liveTask + sizingRules}
      saved={liveTask}
      revision={12}
      tokenCount={596}
      className="h-96"
    />
  ),
};

export const Empty: Story = {
  render: () => <Editor initial="" saved="" revision={1} />,
};
