import type { StudioTool, StudioToolCall } from "../../../api/types";
import type { AccessChange } from "../chatModel";
import type { Proposal } from "../pendingModel";

/** The windows Tools offers, in hours: a day, three days, a week. */
export const TOOL_WINDOW_HOURS: readonly number[] = [24, 72, 168];
export const TOOL_DEFAULT_HOURS = 24;

/** A tool failing this share of its calls or more is flagged. */
export const TOOL_FAIL_SHARE = 0.1;

/** Why a tool deserves a look. */
export type ToolFlag =
  | { kind: "never_called" }
  | { kind: "idle_agents"; count: number }
  | { kind: "failing"; percent: number }
  | { kind: "needs_approval" };

export function toolFlagLabel(flag: ToolFlag): string {
  if (flag.kind === "never_called") return "never called";
  if (flag.kind === "idle_agents") return `${flag.count} never call it`;
  if (flag.kind === "failing") return `${flag.percent}% fail`;
  return "needs approval";
}

/** The agents offered a tool that never called it in the window. */
export function offeredNeverCalled(tool: StudioTool): string[] {
  return tool.agents
    .filter((usage) => usage.offered && usage.calls === 0)
    .map((usage) => usage.agent_id);
}

/** What stands out about a tool: unused, unused by some, failing, or waiting on an access change. */
export function toolFlags(tool: StudioTool, pending: boolean): ToolFlag[] {
  const flags: ToolFlag[] = [];
  const idle = offeredNeverCalled(tool).length;
  if (!tool.calls && tool.offered_to.length) flags.push({ kind: "never_called" });
  if (tool.calls && idle) flags.push({ kind: "idle_agents", count: idle });
  if (tool.calls && tool.errors / tool.calls >= TOOL_FAIL_SHARE) {
    flags.push({ kind: "failing", percent: Math.round((100 * tool.errors) / tool.calls) });
  }
  if (pending) flags.push({ kind: "needs_approval" });
  return flags;
}

/** The agent that called a tool most, and its share of the calls. */
export function mostCalledBy(tool: StudioTool): { agent_id: string; share: number } | null {
  const top = tool.agents.reduce<StudioTool["agents"][number] | null>(
    (best, usage) => (usage.calls > (best?.calls ?? 0) ? usage : best),
    null,
  );
  return top && tool.calls ? { agent_id: top.agent_id, share: top.calls / tool.calls } : null;
}

/**
 * The tools an open access change touches: a native or connection tool by name, a whole
 * connection by its server.
 */
export function toolsAwaitingApproval(
  proposals: readonly Proposal[],
  tools: readonly StudioTool[],
): Set<string> {
  const changes = proposals.flatMap((proposal) =>
    proposal.state === "open" && proposal.widget.kind === "edit"
      ? (proposal.widget.edit.changes ?? [])
      : [],
  );
  return new Set(changes.flatMap((change) => toolsTouched(change, tools)));
}

const toolChanges: Record<
  AccessChange["kind"],
  (id: string, tools: readonly StudioTool[]) => string[]
> = {
  native_tool: (id) => [id],
  mcp_tool: (id) => [id],
  mcp: (id, tools) => tools.filter((tool) => tool.server_id === id).map((tool) => tool.name),
};

function toolsTouched(change: AccessChange, tools: readonly StudioTool[]): string[] {
  return toolChanges[change.kind](change.id, tools);
}

export type ToolFilters = {
  source: "all" | "native" | "script" | "connector";
  /** Only tools this agent is offered or called. */
  agent: string | null;
  needsLook: boolean;
  query: string;
};

export const noToolFilters: ToolFilters = {
  source: "all",
  agent: null,
  needsLook: false,
  query: "",
};

const filterTests: Array<(tool: StudioTool, filters: ToolFilters, flagged: boolean) => boolean> = [
  (tool, filters) => filters.source === "all" || tool.source === filters.source,
  (tool, filters) =>
    !filters.agent || tool.agents.some((usage) => usage.agent_id === filters.agent),
  (_tool, filters, flagged) => !filters.needsLook || flagged,
  (tool, filters) =>
    `${tool.name} ${tool.group} ${tool.description}`
      .toLowerCase()
      .includes(filters.query.trim().toLowerCase()),
];

function matches(tool: StudioTool, filters: ToolFilters, flagged: boolean): boolean {
  return filterTests.every((passes) => passes(tool, filters, flagged));
}

/** The tools the filters keep, most called first, then by name. */
export function filterTools(
  tools: readonly StudioTool[],
  filters: ToolFilters,
  flagsOf: (tool: StudioTool) => ToolFlag[],
): StudioTool[] {
  return tools
    .filter((tool) => matches(tool, filters, flagsOf(tool).length > 0))
    .sort((a, b) => b.calls - a.calls || a.name.localeCompare(b.name));
}

/** Failed calls grouped by their error, most frequent first. */
export function errorGroups(
  calls: readonly StudioToolCall[],
): Array<{ message: string; count: number; last_at: string }> {
  const groups = new Map<string, { message: string; count: number; last_at: string }>();
  for (const call of calls) {
    if (call.status !== "error") continue;
    const message = call.error ?? "error";
    const group = groups.get(message) ?? { message, count: 0, last_at: call.at };
    groups.set(message, {
      ...group,
      count: group.count + 1,
      last_at: call.at > group.last_at ? call.at : group.last_at,
    });
  }
  return [...groups.values()].sort(
    (a, b) => b.count - a.count || b.last_at.localeCompare(a.last_at),
  );
}

/** A duration in words: milliseconds under a second, else seconds. */
export function formatDuration(ms: number | null): string {
  if (ms === null) return "—";
  return ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`;
}
