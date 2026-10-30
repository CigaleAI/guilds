import { ArrowLeft, MessageCircleQuestion } from "lucide-react";
import { useState } from "react";
import { useStudioToolCalls } from "../../../api/queries";
import type { StudioAgent, StudioTool, StudioToolCall } from "../../../api/types";
import { relativeTime } from "../../../app/format";
import { Banner, Button, Icon, Segmented, SkeletonRows, StatBand, Tag, cn } from "@guildsrun/ui";
import { DetailHeader } from "../MasterDetail";
import { useStudio } from "../StudioContext";
import { OfferedAgents } from "./OfferedAgents";
import {
  errorGroups,
  formatDuration,
  offeredNeverCalled,
  toolFlagLabel,
  type ToolFlag,
} from "./toolsModel";

const sourceLabel: Record<string, string> = {
  native: "native tool",
  script: "script tool",
  connector: "connection tool",
};

/** One tool: its numbers, who calls it and how, its errors, and each call, to open or ask about. */
export function ToolDetail({
  tool,
  hours,
  flags,
}: {
  tool: StudioTool;
  hours: number;
  flags: ToolFlag[];
}) {
  const { agents, go, ask } = useStudio();
  const users = tool.agents.filter((usage) => usage.offered && usage.calls > 0).length;
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto p-5">
      <Button
        variant="ghost"
        size="sm"
        className="self-start"
        onClick={() => go({ section: "tools" })}
      >
        <Icon icon={ArrowLeft} size={14} />
        All tools
      </Button>
      <DetailHeader
        title={<span className="font-mono">{tool.name}</span>}
        meta={
          <span className="flex flex-wrap items-center gap-1.5">
            {tool.source ? sourceLabel[tool.source] : "no longer offered"} · {tool.group}
            {flags.map((flag) => (
              <Tag
                key={flag.kind}
                tone={flag.kind === "needs_approval" ? "signal" : "ochre"}
                font="sans"
              >
                {toolFlagLabel(flag)}
              </Tag>
            ))}
          </span>
        }
        actions={
          <Button
            variant="outline"
            size="sm"
            onClick={() =>
              ask({ kind: "tool", tool_name: tool.name, label: `Tool · ${tool.name}` })
            }
          >
            <Icon icon={MessageCircleQuestion} size={14} />
            Ask the coach
          </Button>
        }
      />
      {tool.description ? <p className="text-sm text-fg-2">{tool.description}</p> : null}
      <StatBand
        className="rounded-lg"
        stats={[
          { value: tool.calls, label: "calls" },
          {
            value: tool.calls ? `${Math.round((100 * tool.errors) / tool.calls)}%` : "—",
            label: "error rate",
          },
          { value: formatDuration(tool.median_ms), label: "median" },
          { value: `${users} of ${tool.offered_to.length}`, label: "offered agents use it" },
        ]}
      />
      <section className="flex flex-col gap-2">
        <h3 className="type-label text-muted">Offered to</h3>
        <OfferedAgents tool={tool} agents={agents} />
      </section>
      <CallersSection tool={tool} agents={agents} />
      <IdleSection tool={tool} agents={agents} />
      <ToolCalls tool={tool} hours={hours} agents={agents} />
    </div>
  );
}

function nameOf(agents: StudioAgent[], id: string): string {
  return agents.find((agent) => agent.id === id)?.name ?? id;
}

/** Each agent that called the tool, with its ok and failed calls as one bar. */
function CallersSection({ tool, agents }: { tool: StudioTool; agents: StudioAgent[] }) {
  const callers = tool.agents.filter((usage) => usage.calls > 0).sort((a, b) => b.calls - a.calls);
  const most = callers[0]?.calls ?? 0;
  if (!callers.length) return null;
  return (
    <section className="flex flex-col gap-2">
      <h3 className="type-label text-muted">Who calls it</h3>
      <ul className="flex flex-col gap-1.5">
        {callers.map((usage) => (
          <li
            key={usage.agent_id}
            className="grid grid-cols-[10rem_1fr_8rem] items-center gap-3 text-sm"
          >
            <span className="truncate font-mono">{nameOf(agents, usage.agent_id)}</span>
            <span className="flex h-3 overflow-hidden rounded-full bg-well" aria-hidden>
              <span
                className="bg-tide"
                style={{ width: `${(100 * (usage.calls - usage.errors)) / most}%` }}
              />
              <span className="bg-plum" style={{ width: `${(100 * usage.errors) / most}%` }} />
            </span>
            <span className="text-right text-xs text-fg-2">
              {usage.calls} · {usage.errors} failed
              {usage.offered ? "" : " · not offered now"}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

function IdleSection({ tool, agents }: { tool: StudioTool; agents: StudioAgent[] }) {
  const idle = offeredNeverCalled(tool);
  if (!idle.length) return null;
  return (
    <section className="flex flex-col gap-2">
      <h3 className="type-label text-muted">Offered, never called</h3>
      <p className="text-sm text-fg-2">{idle.map((id) => nameOf(agents, id)).join(", ")}</p>
    </section>
  );
}

/** The tool's calls in the window, newest first, all or only the failed ones. */
function ToolCalls({
  tool,
  hours,
  agents,
}: {
  tool: StudioTool;
  hours: number;
  agents: StudioAgent[];
}) {
  const { session } = useStudio();
  const [errorsOnly, setErrorsOnly] = useState(false);
  const calls = useStudioToolCalls(session.id, tool.name, hours, errorsOnly);
  const failures = useStudioToolCalls(session.id, tool.name, hours, true);
  const rows = calls.data?.pages.flatMap((page) => page.calls) ?? [];
  const groups = errorGroups(failures.data?.pages.flatMap((page) => page.calls) ?? []);
  return (
    <>
      {groups.length ? (
        <section className="flex flex-col gap-2">
          <h3 className="type-label text-muted">Errors by message</h3>
          <ul className="flex flex-col gap-1">
            {groups.map((group) => (
              <li
                key={group.message}
                className="flex items-baseline gap-3 rounded-md bg-surface px-3 py-2 text-sm"
              >
                <span className="font-mono text-xs">{group.count}×</span>
                <span className="min-w-0 flex-1 break-words">{group.message}</span>
                <span className="text-xs text-muted">{relativeTime(group.last_at)}</span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      <section className="flex flex-col gap-2">
        <div className="flex items-center gap-3">
          <h3 className="type-label text-muted">Calls</h3>
          <Segmented
            size="sm"
            label="Calls shown"
            value={errorsOnly ? "errors" : "all"}
            onValueChange={(value) => setErrorsOnly(value === "errors")}
            options={[
              { value: "all", label: "All" },
              { value: "errors", label: "Errors" },
            ]}
          />
        </div>
        {calls.isError ? (
          <Banner tone="error" title="Couldn't load the calls" meta={calls.error.message} />
        ) : calls.isPending ? (
          <SkeletonRows rows={4} label="Loading calls" />
        ) : !rows.length ? (
          <p className="text-sm text-muted">No calls in this window.</p>
        ) : (
          <ul className="flex flex-col gap-1">
            {rows.map((call) => (
              <CallRow
                key={`${call.run_id}:${call.call_id ?? call.seq}`}
                call={call}
                agents={agents}
              />
            ))}
          </ul>
        )}
        {calls.hasNextPage ? (
          <Button
            variant="ghost"
            size="sm"
            className="self-start"
            disabled={calls.isFetchingNextPage}
            onClick={() => void calls.fetchNextPage()}
          >
            Load older calls
          </Button>
        ) : null}
      </section>
    </>
  );
}

function CallRow({ call, agents }: { call: StudioToolCall; agents: StudioAgent[] }) {
  const { openStep } = useStudio();
  return (
    <li className="flex items-center gap-3 rounded-md bg-surface px-3 py-2 text-sm">
      <span className="w-20 shrink-0 text-xs text-muted" title={call.at}>
        {relativeTime(call.at)}
      </span>
      <span className="w-28 shrink-0 truncate font-mono text-xs">
        {nameOf(agents, call.agent_id)}
      </span>
      <span
        className="min-w-0 flex-1 truncate font-mono text-xs text-fg-2"
        title={call.error ?? call.arguments}
      >
        {call.error ?? call.arguments}
      </span>
      <Tag tone={call.status === "error" ? "plum" : "tide"} font="sans">
        {call.status}
      </Tag>
      <span className={cn("w-16 shrink-0 text-right text-xs text-fg-2")}>
        {formatDuration(call.duration_ms)}
      </span>
      <Button
        variant="ghost"
        size="xs"
        onClick={() =>
          openStep({
            agentId: call.agent_id,
            runId: call.run_id,
            call: call.call_id,
            seq: call.seq,
          })
        }
      >
        Open step
      </Button>
    </li>
  );
}
