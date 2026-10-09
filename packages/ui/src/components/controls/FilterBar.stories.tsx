import type { Meta, StoryObj } from "@storybook/react-vite";
import { useState } from "react";
import { Button } from "../actions/Button";
import { FilterBar } from "./FilterBar";

const meta: Meta<typeof FilterBar> = {
  title: "Components/Controls/FilterBar",
  component: FilterBar,
};
export default meta;

type Story = StoryObj<typeof FilterBar>;

type ToolStatus = "all" | "active" | "disabled";

function ToolFilter() {
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState<ToolStatus>("all");
  return (
    <FilterBar
      query={query}
      onQueryChange={setQuery}
      placeholder="Filter 12 tools…"
      searchLabel="Filter tools"
      size="sm"
      filter={{
        value: status,
        onValueChange: setStatus,
        label: "Tool status",
        options: [
          { value: "all", label: "All", count: 12 },
          { value: "active", label: "Active", count: 3 },
          { value: "disabled", label: "Disabled", count: 9 },
        ],
      }}
      actions={
        <>
          <Button variant="outline" size="sm">
            Enable all
          </Button>
          <Button variant="outline" size="sm">
            Disable all
          </Button>
          <Button variant="ghost" size="sm" className="text-plum-t">
            Reset to inherit
          </Button>
        </>
      }
    />
  );
}

type IssueStatus = "open" | "resolved" | "all";

function IssueFilter() {
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState<IssueStatus>("open");
  return (
    <FilterBar
      query={query}
      onQueryChange={setQuery}
      placeholder="Search issues…"
      searchLabel="Search issues"
      filter={{
        value: status,
        onValueChange: setStatus,
        label: "Issue status",
        options: [
          { value: "open", label: "Open", count: 26 },
          { value: "resolved", label: "Resolved", count: 112 },
          { value: "all", label: "All", count: 138 },
        ],
      }}
    />
  );
}

export const Tools: Story = {
  render: () => (
    <div className="rounded-xl bg-surface p-2">
      <div className="rounded-lg bg-paper px-3.5 py-3">
        <ToolFilter />
      </div>
    </div>
  ),
};

export const Issues: Story = {
  render: () => (
    <div className="rounded-2xl bg-paper p-6">
      <IssueFilter />
    </div>
  ),
};

export const Narrow: Story = {
  render: () => (
    <div className="max-w-sm rounded-2xl bg-paper p-4">
      <ToolFilter />
    </div>
  ),
};
