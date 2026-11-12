import { Link } from "@tanstack/react-router";
import { OctagonAlert } from "lucide-react";
import { useSetIssueStatus } from "../../api/queries/issues";
import { useDisablingIssue } from "../../app/issues";
import { Button, Icon, toast } from "@guildsrun/ui";

type DisabledAgentNoticeProps = { guildId: string; agentId: string; agentName: string };

/**
 * A red band on an agent's page while a blocking issue disables it: the issue it reported, that
 * it runs nothing until the issue is resolved, and the two ways on: resolve it here, or open it
 * in the guild's issues. Nothing while the agent is not disabled.
 */
export function DisabledAgentNotice({ guildId, agentId, agentName }: DisabledAgentNoticeProps) {
  const issue = useDisablingIssue(guildId, agentId);
  const setStatus = useSetIssueStatus(guildId);
  if (!issue) return null;
  return (
    <div
      role="alert"
      className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-2 bg-alert px-4 py-2.5 text-on-alert"
    >
      <Icon icon={OctagonAlert} size={18} />
      <div className="flex min-w-40 flex-1 flex-col gap-0.5">
        <span className="text-md font-semibold">
          <span className="font-mono">{agentName}</span> is disabled by a blocking issue
        </span>
        <span className="text-sm">
          {issue.summary}. It starts no run, from chat, the group chat or a routine, until the issue
          is resolved.
        </span>
      </div>
      <Button
        variant="secondary"
        size="sm"
        disabled={setStatus.isPending}
        onClick={() =>
          setStatus.mutate(
            { issueId: issue.id, status: "resolved" },
            {
              onError: (error) =>
                toast({
                  kind: "error",
                  title: "Couldn't resolve the issue",
                  description: error.message,
                }),
            },
          )
        }
      >
        Mark as resolved
      </Button>
      <Link
        to="/guilds/$guildId/issues"
        params={{ guildId }}
        search={{ severity: "blocking" }}
        className="text-sm font-semibold underline underline-offset-2"
      >
        Open issue
      </Link>
    </div>
  );
}
