import { Link, useNavigate, useSearch } from "@tanstack/react-router";
import { CheckCheck } from "lucide-react";
import { useState } from "react";
import { useMarkTagsRead, useNotifications } from "../../api/queries/chat";
import { useSetAnyIssueStatus } from "../../api/queries/issues";
import type { MentionNotice } from "../../api/types/chat";
import { agentLook } from "../../app/agents";
import { relativeTime } from "../../app/format";
import { disablesAgent, type SeverityFilter } from "../../app/issues";
import { IssueSeverityFilter } from "../../app/IssueSeverityFilter";
import {
  Button,
  Markdown,
  Segmented,
  IssueCard,
  Banner,
  EmptyState,
  SkeletonRows,
  Avatar,
  toast,
  Icon,
  cn,
} from "@guildsrun/ui";
import { useInvestigateIssue } from "../studio/investigate";
import { entryGround, inboxEntries, type InboxFilter } from "./entries";

type MentionCardProps = { notice: MentionNotice };

function MentionCard({ notice }: MentionCardProps) {
  const look = notice.agent ? agentLook(notice.agent) : null;
  return (
    <article className={cn("flex flex-col gap-2 rounded-xl p-4", entryGround.tag)}>
      <div className="flex flex-wrap items-center gap-2.5">
        {look ? (
          <Avatar name={notice.author_name} size={28} {...look} />
        ) : (
          <Avatar name={notice.author_name} tone="dusk" size={28} round />
        )}
        <div className="flex min-w-0 flex-1 flex-col">
          <span className="text-md font-semibold">{notice.author_name} tagged you</span>
          <span className="text-xs text-muted">{notice.guild_name}</span>
        </div>
        <span className="font-mono text-2xs text-muted">{relativeTime(notice.created_at)}</span>
        <Button asChild variant="outline" size="sm">
          <Link
            to="/guilds/$guildId"
            params={{ guildId: notice.guild_id }}
            search={{ seq: notice.seq }}
          >
            Open in chat
          </Link>
        </Button>
      </div>
      <Markdown density="compact">{notice.content}</Markdown>
    </article>
  );
}

/**
 * What needs the operator, across the guilds they operate: messages that tag them and issues agents
 * reported. Reading the chat clears a tag; resolving an issue clears it. The address holds the
 * severity the issues are filtered to.
 */
export function Inbox() {
  const navigate = useNavigate();
  const notifications = useNotifications();
  const setStatus = useSetAnyIssueStatus();
  const markTagsRead = useMarkTagsRead();
  const { investigate } = useInvestigateIssue();
  const [filter, setFilter] = useState<InboxFilter>("all");
  const severity: SeverityFilter = useSearch({ from: "/inbox" }).severity ?? "all";

  const tags = notifications.data?.mentions ?? [];
  const issues = notifications.data?.issues ?? [];
  const entries = inboxEntries(notifications.data, filter, severity);

  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-6 py-8 md:px-10">
      <div className="mx-auto flex max-w-240 flex-col gap-5">
        <header className="flex flex-wrap items-end gap-3">
          <div className="flex min-w-60 flex-1 flex-col gap-1">
            <h1 className="type-h1">Inbox</h1>
            <p className="text-sm text-fg-2">
              Issues agents reported and messages that tag you, from the guilds you operate.
              Resolving an issue or reading the chat clears it.
            </p>
          </div>
          {tags.length ? (
            <Button
              variant="ghost"
              size="sm"
              disabled={markTagsRead.isPending}
              onClick={() =>
                markTagsRead.mutate(undefined, {
                  onError: (error) =>
                    toast({
                      kind: "error",
                      title: "Couldn't mark tags as read",
                      description: error.message,
                    }),
                })
              }
            >
              <Icon icon={CheckCheck} size={14} />
              Mark tags as read
            </Button>
          ) : null}
          <Segmented
            size="sm"
            label="Show"
            value={filter}
            onValueChange={setFilter}
            options={[
              { value: "all", label: "All", count: tags.length + issues.length },
              { value: "tags", label: "Tags", count: tags.length },
              { value: "issues", label: "Issues", count: issues.length },
            ]}
          />
        </header>
        <IssueSeverityFilter
          issues={issues}
          value={severity}
          onValueChange={(next) =>
            void navigate({
              to: "/inbox",
              search: next === "all" ? {} : { severity: next },
              replace: true,
            })
          }
        />

        {notifications.isPending ? (
          <SkeletonRows rows={5} label="Loading the inbox" />
        ) : notifications.isError ? (
          <Banner
            tone="error"
            title="Couldn't load the inbox"
            meta={notifications.error.message}
            action={
              <Button variant="outline" size="sm" onClick={() => void notifications.refetch()}>
                Retry
              </Button>
            }
          />
        ) : entries.length === 0 ? (
          <EmptyState
            icon={CheckCheck}
            title={severity === "all" ? "Nothing needs you" : "No issue of this severity"}
            description="Agents' issues and messages that tag you appear here for the guilds you operate."
          />
        ) : (
          <div className="flex flex-col gap-3">
            {entries.map((entry) => {
              if (entry.kind === "tag")
                return <MentionCard key={`tag-${entry.notice.id}`} notice={entry.notice} />;
              const issue = entry.issue;
              const look = issue.agent ? agentLook(issue.agent) : { tone: "dusk" as const };
              const agentId = issue.agent_id;
              const runId = issue.run_id;
              return (
                <IssueCard
                  key={`issue-${issue.id}`}
                  className={entryGround.issue}
                  summary={issue.summary}
                  kind={issue.kind}
                  severity={issue.severity}
                  status={issue.status}
                  disablesAgent={disablesAgent(issue)}
                  guildName={issue.guild_name}
                  agent={{ name: issue.agent?.name ?? issue.agent_name, ...look }}
                  age={relativeTime(issue.created_at)}
                  {...(issue.tool_name ? { toolName: issue.tool_name } : {})}
                  {...(issue.detail
                    ? { detail: <Markdown density="compact">{issue.detail}</Markdown> }
                    : {})}
                  {...(issue.status === "open"
                    ? { onInvestigate: () => void investigate(issue) }
                    : {})}
                  onStatusChange={(status) =>
                    setStatus.mutate(
                      { guildId: issue.guild_id, issueId: issue.id, status },
                      {
                        onError: (error) =>
                          toast({
                            kind: "error",
                            title: "Couldn't update the issue",
                            description: error.message,
                          }),
                      },
                    )
                  }
                  {...(agentId && runId
                    ? {
                        onOpenRun: () =>
                          void navigate({
                            to: "/guilds/$guildId/agents/$agentId",
                            params: { guildId: issue.guild_id, agentId },
                            search: { run: runId },
                          }),
                      }
                    : {})}
                  pending={setStatus.isPending && setStatus.variables.issueId === issue.id}
                />
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
