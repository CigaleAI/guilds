import { useState } from "react";
import { useStudioTools } from "../../../api/queries";
import type { StudioAgent, StudioTool } from "../../../api/types";
import { relativeTime } from "../../../app/format";
import {
  Banner,
  Checkbox,
  DataTable,
  FilterBar,
  Select,
  Segmented,
  SkeletonRows,
  Tag,
  type DataTableColumn,
} from "@guildsrun/ui";
import { useStudio } from "../StudioContext";
import { OfferedAgents } from "./OfferedAgents";
import { ToolDetail } from "./ToolDetail";
import {
  TOOL_DEFAULT_HOURS,
  TOOL_WINDOW_HOURS,
  filterTools,
  formatDuration,
  mostCalledBy,
  noToolFilters,
  toolFlagLabel,
  toolFlags,
  toolsAwaitingApproval,
  type ToolFilters,
} from "./toolsModel";

const hoursKey = "studio.tools.hours";
const windowLabel: Record<number, string> = { 24: "24 h", 72: "3 d", 168: "7 d" };
const allAgents = "all";

function storedHours(): number {
  try {
    const value = Number(localStorage.getItem(hoursKey));
    return TOOL_WINDOW_HOURS.includes(value) ? value : TOOL_DEFAULT_HOURS;
  } catch {
    return TOOL_DEFAULT_HOURS;
  }
}

function storeHours(hours: number) {
  try {
    localStorage.setItem(hoursKey, String(hours));
  } catch {
    // Without storage the window resets on the next visit.
  }
}

/**
 * Every tool the guild's agents are offered or called in the window: who is offered it, how often
 * it is called, how often it fails and how long it takes; a tool opens to its calls.
 */
export function ToolsSection() {
  const { session, search, approvals } = useStudio();
  const [hours, setHours] = useState(storedHours);
  const tools = useStudioTools(session.id, hours);
  const pending = toolsAwaitingApproval(approvals.proposals, tools.data ?? []);
  const flagsOf = (tool: StudioTool) => toolFlags(tool, pending.has(tool.name));
  const changeHours = (next: number) => {
    setHours(next);
    storeHours(next);
  };

  if (tools.isError) {
    return (
      <div className="p-5">
        <Banner tone="error" title="Couldn't load the tools" meta={tools.error.message} />
      </div>
    );
  }
  if (!tools.data) return <SkeletonRows rows={6} label="Loading tools" className="p-5" />;
  const selected = tools.data.find((tool) => tool.name === search.item);
  if (selected) {
    return <ToolDetail tool={selected} hours={hours} flags={flagsOf(selected)} />;
  }
  return (
    <ToolList tools={tools.data} flagsOf={flagsOf} hours={hours} onHoursChange={changeHours} />
  );
}

function ToolList({
  tools,
  flagsOf,
  hours,
  onHoursChange,
}: {
  tools: StudioTool[];
  flagsOf: (tool: StudioTool) => ReturnType<typeof toolFlags>;
  hours: number;
  onHoursChange: (hours: number) => void;
}) {
  const { agents, go } = useStudio();
  const [filters, setFilters] = useState<ToolFilters>(noToolFilters);
  const rows = filterTools(tools, filters, flagsOf);
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3 p-4">
      <ToolFiltersBar
        filters={filters}
        onChange={setFilters}
        agents={agents}
        hours={hours}
        onHoursChange={onHoursChange}
      />
      <DataTable
        label="Tools"
        tone="surface"
        className="min-h-0 flex-1 rounded-lg"
        tableClassName="min-w-240"
        columns={toolColumns(agents, flagsOf)}
        rows={rows}
        getRowKey={(row) => row.name}
        onRowClick={(row) => go({ section: "tools", item: row.name })}
        empty={<span className="text-muted">No tool matches these filters.</span>}
      />
    </div>
  );
}

function ToolFiltersBar({
  filters,
  onChange,
  agents,
  hours,
  onHoursChange,
}: {
  filters: ToolFilters;
  onChange: (filters: ToolFilters) => void;
  agents: StudioAgent[];
  hours: number;
  onHoursChange: (hours: number) => void;
}) {
  return (
    <FilterBar
      query={filters.query}
      onQueryChange={(query) => onChange({ ...filters, query })}
      placeholder="Search tools…"
      searchLabel="Search tools"
      size="sm"
      filter={{
        label: "Source",
        value: filters.source,
        onValueChange: (source) => onChange({ ...filters, source }),
        options: [
          { value: "all", label: "All" },
          { value: "native", label: "Native" },
          { value: "script", label: "Scripts" },
          { value: "connector", label: "Connectors" },
        ],
      }}
      actions={
        <>
          <Select
            tone="surface"
            aria-label="Agent"
            className="w-44"
            value={filters.agent ?? allAgents}
            onValueChange={(value) =>
              onChange({ ...filters, agent: value === allAgents ? null : value })
            }
            options={[
              { value: allAgents, label: "All agents" },
              ...agents.map((agent) => ({ value: agent.id, label: agent.name })),
            ]}
          />
          <Checkbox
            label="Needs a look"
            checked={filters.needsLook}
            onCheckedChange={(value) => onChange({ ...filters, needsLook: value === true })}
          />
          <Segmented
            size="sm"
            mono
            label="Window"
            value={String(hours)}
            onValueChange={(value) => onHoursChange(Number(value))}
            options={TOOL_WINDOW_HOURS.map((value) => ({
              value: String(value),
              label: windowLabel[value] ?? `${value} h`,
            }))}
          />
        </>
      }
    />
  );
}

function agentName(agents: StudioAgent[], id: string): string {
  return agents.find((agent) => agent.id === id)?.name ?? id;
}

function toolColumns(
  agents: StudioAgent[],
  flagsOf: (tool: StudioTool) => ReturnType<typeof toolFlags>,
): DataTableColumn<StudioTool>[] {
  return [
    {
      id: "tool",
      header: "Tool",
      className: "min-w-64",
      cell: (tool) => (
        <span className="flex flex-col gap-1">
          <span className="font-mono text-sm font-medium">{tool.name}</span>
          <span className="flex flex-wrap items-center gap-1 text-xs text-muted">
            {tool.group}
            {flagsOf(tool).map((flag) => (
              <Tag
                key={flag.kind}
                tone={flag.kind === "needs_approval" ? "signal" : "ochre"}
                font="sans"
              >
                {toolFlagLabel(flag)}
              </Tag>
            ))}
          </span>
        </span>
      ),
    },
    {
      id: "offered",
      header: "Offered to",
      cell: (tool) => <OfferedAgents tool={tool} agents={agents} />,
    },
    { id: "calls", header: "Calls", align: "end", cell: (tool) => tool.calls },
    { id: "errors", header: "Errors", align: "end", cell: (tool) => tool.errors },
    {
      id: "median",
      header: "Median",
      align: "end",
      cell: (tool) => formatDuration(tool.median_ms),
    },
    {
      id: "top",
      header: "Most called by",
      cell: (tool) => {
        const top = mostCalledBy(tool);
        return top ? `${agentName(agents, top.agent_id)} · ${Math.round(top.share * 100)}%` : "—";
      },
    },
    {
      id: "last",
      header: "Last call",
      cell: (tool) => (tool.last_at ? relativeTime(tool.last_at) : "—"),
    },
  ];
}
