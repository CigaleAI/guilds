import { useNavigate, useParams } from "@tanstack/react-router";
import { CheckCheck, Flag } from "lucide-react";
import { useState } from "react";
import {
  useGuildIssues,
  useResolveOpenIssues,
  useSetIssueStatus,
} from "../../../api/queries/issues";
import type { Issue } from "../../../api/types";
import { agentLook } from "../../../app/agents";
import { relativeTime } from "../../../app/format";
import {
  Button,
  Markdown,
  Segmented,
  IssueCard,
  Banner,
  EmptyState,
  SkeletonRows,
  toast,
  Icon,
} from "@guildsrun/ui";
import { useInvestigateIssue } from "../../studio/investigate";
import { GuildPage } from "./GuildPage";

type Filter = "open" | "resolved" | "all";

/**
 * Tool failures the guild's agents reported with report_issue. Resolve one once its cause is
 * fixed, or every open row at once; reopen it if it comes back.
 */
export function GuildIssues() {
  const { guildId } = useParams({ from: "/guilds/$guildId" });
  const navigate = useNavigate();
  const issues = useGuildIssues(guildId);
  const setStatus = useSetIssueStatus(guildId);
  const resolveOpen = useResolveOpenIssues(guildId);
  const { investigate } = useInvestigateIssue();
  const [filter, setFilter] = useState<Filter>("open");

  const all = issues.data ?? [];
  const open = all.filter((issue) => issue.status === "open").length;
  const listed = filter === "all" ? all : all.filter((issue) => issue.status === filter);

  const change = (issue: Issue, status: Issue["status"]) =>
    setStatus.mutate(
      { issueId: issue.id, status },
      {
        onError: (error) =>
          toast({
            kind: "error",
            title:
              status === "resolved" ? "Couldn't resolve the issue" : "Couldn't reopen the issue",
            description: error.message,
          }),
      },
    );

  return (
    <GuildPage>
      <div className="flex flex-wrap items-center gap-3">
        <p className="min-w-60 flex-1 text-sm text-fg-2">
          Tool failures agents reported with report_issue. Resolve one once its cause is fixed.
        </p>
        {open > 0 ? (
          <Button
            variant="ghost"
            size="sm"
            disabled={resolveOpen.isPending}
            onClick={() =>
              resolveOpen.mutate(undefined, {
                onError: (error) =>
                  toast({
                    kind: "error",
                    title: "Couldn't resolve the issues",
                    description: error.message,
                  }),
              })
            }
          >
            <Icon icon={CheckCheck} size={14} />
            Mark all as resolved
          </Button>
        ) : null}
        <Segmented
          size="sm"
          label="Issue status"
          value={filter}
          onValueChange={setFilter}
          options={[
            { value: "open", label: "Open", count: open },
            { value: "resolved", label: "Resolved", count: all.length - open },
            { value: "all", label: "All", count: all.length },
          ]}
        />
      </div>

      {issues.isPending ? (
        <SkeletonRows rows={4} label="Loading issues" />
      ) : issues.isError ? (
        <Banner
          tone="error"
          title="Couldn't load the issues"
          meta={issues.error.message}
          action={
            <Button variant="outline" size="sm" onClick={() => void issues.refetch()}>
              Retry
            </Button>
          }
        />
      ) : listed.length === 0 ? (
        <EmptyState
          icon={Flag}
          title={filter === "open" ? "No open issues" : "No issues"}
          description="Agents report an issue when a tool fails, a result is cut short, or a login errors."
        />
      ) : (
        <div className="flex flex-col gap-3">
          {listed.map((issue) => {
            const look = issue.agent ? agentLook(issue.agent) : { tone: "dusk" as const };
            const agentId = issue.agent_id;
            const runId = issue.run_id;
            return (
              <IssueCard
                key={issue.id}
                summary={issue.summary}
                kind={issue.kind}
                severity={issue.severity}
                status={issue.status}
                agent={{ name: issue.agent?.name ?? issue.agent_name, ...look }}
                age={relativeTime(issue.created_at)}
                {...(issue.tool_name ? { toolName: issue.tool_name } : {})}
                {...(issue.resolved_by ? { resolvedBy: issue.resolved_by } : {})}
                {...(issue.detail
                  ? { detail: <Markdown density="compact">{issue.detail}</Markdown> }
                  : {})}
                {...(issue.status === "open"
                  ? { onInvestigate: () => void investigate(issue) }
                  : {})}
                onStatusChange={(status) => change(issue, status)}
                {...(agentId && runId
                  ? {
                      onOpenRun: () =>
                        void navigate({
                          to: "/guilds/$guildId/agents/$agentId",
                          params: { guildId, agentId },
                          search: { run: runId },
                        }),
                    }
                  : {})}
                pending={
                  resolveOpen.isPending ||
                  (setStatus.isPending && setStatus.variables.issueId === issue.id)
                }
              />
            );
          })}
        </div>
      )}
    </GuildPage>
  );
}
