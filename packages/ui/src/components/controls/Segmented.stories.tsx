import type { Meta, StoryObj } from "@storybook/react-vite";
import { useState } from "react";
import { Segmented, type SegmentedOption } from "./Segmented";

const meta: Meta<typeof Segmented> = {
  title: "Components/Controls/Segmented",
  component: Segmented,
};
export default meta;

type Story = StoryObj<typeof Segmented>;

function Demo<T extends string>(props: {
  initial: T;
  options: readonly SegmentedOption<T>[];
  label: string;
  size?: "sm" | "md";
  mono?: boolean;
  disabled?: boolean;
}) {
  const [value, setValue] = useState<T>(props.initial);
  return (
    <Segmented
      value={value}
      onValueChange={setValue}
      options={props.options}
      label={props.label}
      size={props.size ?? "md"}
      mono={props.mono ?? false}
      disabled={props.disabled ?? false}
    />
  );
}

const ranges = (["1h", "6h", "1d", "3d", "7d"] as const).map((value) => ({ value, label: value }));

export const Uses: Story = {
  render: () => (
    <div className="flex flex-col gap-5 rounded-xl bg-surface p-6">
      <div className="flex flex-wrap items-center gap-3">
        <Demo initial="1d" options={ranges} label="Time range" size="sm" mono />
        <Demo
          initial="formatted"
          label="Note view"
          options={[
            { value: "formatted", label: "Formatted" },
            { value: "markdown", label: "Markdown" },
          ]}
        />
        <Demo
          initial="edit"
          label="Prompt mode"
          options={[
            { value: "edit", label: "Edit" },
            { value: "preview", label: "Preview" },
          ]}
        />
      </div>
      <Demo
        initial="all"
        label="Inbox filter"
        options={[
          { value: "all", label: "All" },
          { value: "tags", label: "Tags", count: 8 },
          { value: "issues", label: "Issues", count: 14 },
        ]}
      />
      <Demo
        initial="open"
        label="Issue status"
        options={[
          { value: "open", label: "Open", count: 26 },
          { value: "resolved", label: "Resolved", count: 112 },
          { value: "all", label: "All", count: 138 },
        ]}
      />
      <Demo
        initial="all"
        label="Tool status"
        size="sm"
        options={[
          { value: "all", label: "All", count: 12 },
          { value: "active", label: "Active", count: 3 },
          { value: "disabled", label: "Disabled", count: 9 },
        ]}
      />
    </div>
  ),
};

export const Sizes: Story = {
  render: () => (
    <div className="flex flex-wrap items-center gap-3 rounded-xl bg-surface p-6">
      {(["sm", "md"] as const).map((size) => (
        <Demo
          key={size}
          initial="open"
          label={`Issue status ${size}`}
          size={size}
          options={[
            { value: "open", label: "Open", count: 26 },
            { value: "resolved", label: "Resolved", count: 112 },
            { value: "all", label: "All" },
          ]}
        />
      ))}
    </div>
  ),
};

export const Disabled: Story = {
  render: () => (
    <div className="flex flex-wrap items-center gap-3 rounded-xl bg-surface p-6">
      <Demo initial="6h" options={ranges} label="Time range" size="sm" mono disabled />
      <Demo
        initial="all"
        label="Tool status"
        size="sm"
        options={[
          { value: "all", label: "All", count: 12 },
          { value: "active", label: "Active", count: 0, disabled: true },
          { value: "disabled", label: "Disabled", count: 12 },
        ]}
      />
    </div>
  ),
};
