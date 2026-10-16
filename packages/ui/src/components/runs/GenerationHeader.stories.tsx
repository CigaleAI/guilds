import type { Meta, StoryObj } from "@storybook/react-vite";
import { useState } from "react";
import type { GenerationFilter } from "./GenerationFilters";
import { GenerationHeader, type GenerationStat } from "./GenerationHeader";

const stats: GenerationStat[] = [
  { label: "2m 14s", title: "1m 31s model · 43s tools" },
  { label: "9 steps" },
  { label: "12 tool calls", title: "read × 5 · execute × 4 · write × 3" },
  { label: "1 failed", tone: "failed" },
  { label: "142k tok", title: "139,204 in · 2,913 out" },
  { label: "$0.0089" },
];

const meta: Meta<typeof GenerationHeader> = {
  title: "Components/Runs/GenerationHeader",
  component: GenerationHeader,
  args: {
    title: "Generation 1",
    stats,
    status: { kind: "errors", count: 1 },
  },
};
export default meta;

type Story = StoryObj<typeof GenerationHeader>;

function Reading() {
  const [filter, setFilter] = useState<GenerationFilter | null>(null);
  const [thinkingHidden, setThinkingHidden] = useState(false);
  const [expanded, setExpanded] = useState(false);
  return (
    <GenerationHeader
      title="Generation 1"
      stats={stats}
      status={{ kind: "errors", count: 1 }}
      counts={{ all: 12, mutations: 5, errors: 1 }}
      filter={filter}
      onFilterChange={setFilter}
      thinkingHidden={thinkingHidden}
      onThinkingHiddenChange={setThinkingHidden}
      expanded={expanded}
      onExpandedChange={setExpanded}
      onJumpToAnswer={() => {}}
      className="border-b border-line"
    />
  );
}

/**
 * The full toolbar: All, Writes and Errors keep those calls in focus; **Hide thinking** drops the
 * reasoning lines; **Expand all** unfolds every thought and group; **Jump to answer** scrolls to
 * the last answer. **Collapse all** folds everything and drops the filter.
 */
export const Toolbar: Story = {
  render: () => (
    <div className="max-w-3xl rounded-xl bg-surface">
      <Reading />
    </div>
  ),
};

export const Done: Story = {
  render: () => (
    <div className="max-w-3xl rounded-xl bg-surface">
      <GenerationHeader
        title="Generation 2"
        stats={[
          { label: "48s" },
          { label: "3 steps" },
          { label: "4 tool calls" },
          { label: "53k tok" },
          { label: "$0.11" },
        ]}
        status={{ kind: "completed" }}
      />
    </div>
  ),
};

/** `sm` for the Studio coach's narrow column. */
export const RunningInCoach: Story = {
  render: () => (
    <div className="max-w-md rounded-xl bg-surface">
      <GenerationHeader
        title="Generation 4"
        size="sm"
        stats={[{ label: "12s" }, { label: "2 steps" }, { label: "3 tool calls" }]}
        status={{ kind: "running" }}
      />
    </div>
  ),
};
