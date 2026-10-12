import type { Meta, StoryObj } from "@storybook/react-vite";
import { useState } from "react";
import type { GenerationFilter } from "./GenerationFilters";
import { GenerationHeader } from "./GenerationHeader";
import type { StepOutcome, StepSegment } from "./stepOutcome";

const pattern: StepOutcome[] = [
  "ok",
  "wrote",
  "ok",
  "ok",
  "ok",
  "failed",
  "ok",
  "ok",
  "ok",
  "wrote",
  "ok",
  "ok",
];

const steps: StepSegment[] = Array.from({ length: 24 }, (_, index) => ({
  weight: 1 + ((index * 7) % 3),
  outcome: pattern[index % pattern.length] ?? "ok",
  label: `Step ${index + 1}`,
}));

const stats = [
  { label: "24 steps" },
  { label: "26 calls" },
  { label: "399k tok", title: "391,204 in · 8,113 out" },
  { label: "$0.02" },
];

const meta: Meta<typeof GenerationHeader> = {
  title: "Components/Runs/GenerationHeader",
  component: GenerationHeader,
  args: {
    title: "Generation 1",
    stats,
    status: { kind: "errors", count: 21 },
    mutations: 4,
    failed: 21,
    steps,
  },
};
export default meta;

type Story = StoryObj<typeof GenerationHeader>;

function WithFilters() {
  const [filters, setFilters] = useState<GenerationFilter[]>(["errors"]);
  return (
    <GenerationHeader
      title={<span title="Model: deepseek/deepseek-v4.1-flash">Generation 1</span>}
      stats={stats}
      status={{ kind: "errors", count: 21 }}
      mutations={4}
      failed={21}
      steps={steps}
      filters={filters}
      onFiltersChange={setFilters}
    />
  );
}

/** The error and mutation chips are the filters: pressed, they dim the other calls. */
export const Errors: Story = {
  render: () => (
    <div className="rounded-xl bg-surface p-6">
      <WithFilters />
    </div>
  ),
};

function Foldable() {
  const [open, setOpen] = useState(false);
  return (
    <GenerationHeader
      title="Generation 4"
      stats={[{ label: "2 steps" }, { label: "4 calls" }, { label: "53k tok" }, { label: "$0.11" }]}
      status={{ kind: "completed" }}
      mutations={2}
      size="sm"
      open={open}
      onOpenChange={setOpen}
    />
  );
}

/** Without `onFiltersChange` the mutations count is a plain pill. */
export const CompletedInCoach: Story = {
  render: () => (
    <div className="max-w-xl rounded-xl bg-surface p-5">
      <Foldable />
    </div>
  ),
};

export const Running: Story = {
  render: () => (
    <div className="rounded-xl bg-surface p-6">
      <GenerationHeader
        title="Generation 2"
        stats={[
          { label: "3 steps" },
          { label: "5 calls" },
          { label: "1.2s model · 87ms tools" },
          { label: "18k tok" },
        ]}
        status={{ kind: "running" }}
        mutations={1}
        steps={[
          { weight: 2, outcome: "ok" },
          { weight: 3, outcome: "wrote" },
          { weight: 1, outcome: "running" },
        ]}
        onFiltersChange={() => {}}
      />
    </div>
  ),
};
