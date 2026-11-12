import { Link } from "@tanstack/react-router";
import { OctagonAlert } from "lucide-react";
import { Icon } from "@guildsrun/ui";
import { disabledAgentsSummary, useDisablingIssues } from "./inbox";

/**
 * A red band above every page while a blocking issue disables an agent in a guild the operator
 * operates. It names the agents and opens the Inbox on the blocking issues.
 */
export function DisabledAgentsBanner() {
  const issues = useDisablingIssues();
  if (!issues.length) return null;
  return (
    <div
      role="alert"
      className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 bg-alert px-4 py-2 text-sm text-on-alert"
    >
      <Icon icon={OctagonAlert} size={16} />
      <span className="min-w-40 flex-1 font-semibold">
        {disabledAgentsSummary(issues.map((issue) => issue.agent?.name ?? issue.agent_name))}
      </span>
      <Link
        to="/inbox"
        search={{ severity: "blocking" }}
        className="rounded-md px-2 py-0.5 font-semibold underline underline-offset-2"
      >
        Review
      </Link>
    </div>
  );
}
