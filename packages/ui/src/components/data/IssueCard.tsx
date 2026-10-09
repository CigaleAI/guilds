import { Check, ExternalLink, Sparkles } from "lucide-react";
import type { ComponentProps, ReactNode } from "react";
import { cn } from "../../cn";
import { identityText, type IdentityTone } from "../../identity";
import { Icon } from "../../primitives/Icon";
import { Tag } from "../../primitives/Tag";
import { Button } from "../actions/Button";
import { Avatar } from "../identity/Avatar";

export type IssueKind = "tool_failure" | "truncated" | "api" | "other";
export type IssueSeverity = "low" | "medium" | "high";
export type IssueStatus = "open" | "resolved";

export const issueKindLabel: Record<IssueKind, string> = {
  tool_failure: "Tool failure",
  truncated: "Truncated",
  api: "API",
  other: "Other",
};

const severityLabel: Record<IssueSeverity, string> = { low: "Low", medium: "Medium", high: "High" };

const severityPill: Record<IssueSeverity, { pill: string; dot: string }> = {
  low: { pill: "bg-t-plum text-t-dusk-fg", dot: "bg-dusk" },
  medium: { pill: "bg-t-ochre text-t-ochre-fg", dot: "bg-ochre" },
  high: { pill: "bg-plum text-on-plum", dot: "bg-plum-soft" },
};

export type IssueAgent = { name: string; tone: IdentityTone; src?: string };

export type IssueCardProps = Omit<ComponentProps<"article">, "children"> & {
  summary: string;
  kind: IssueKind;
  severity: IssueSeverity;
  status: IssueStatus;
  /** The agent that reported it. */
  agent: IssueAgent;
  /** Time since it was reported, such as "6h". */
  age: string;
  /** Named where issues from several guilds share a list, as in the inbox. */
  guildName?: string;
  /** Tool the failure came from. */
  toolName?: string;
  resolvedBy?: string;
  /** The agent's markdown detail, rendered by the caller. */
  detail?: ReactNode;
  onInvestigate?: () => void;
  onStatusChange?: (status: IssueStatus) => void;
  /** Offered when the issue names the run that raised it. */
  onOpenRun?: () => void;
  /** Disables the actions while a change is in flight. */
  pending?: boolean;
};

/** An issue an agent raised with report_issue, and what the operator can do about it. */
export function IssueCard({
  summary,
  kind,
  severity,
  status,
  agent,
  age,
  guildName,
  toolName,
  resolvedBy,
  detail,
  onInvestigate,
  onStatusChange,
  onOpenRun,
  pending = false,
  className,
  ...props
}: IssueCardProps) {
  const open = status === "open";
  const severityStyle = open ? severityPill[severity] : { pill: "bg-well text-muted", dot: "bg-rule" };

  return (
    <article className={cn("flex min-w-0 flex-col gap-3 rounded-xl bg-paper p-4 text-fg", className)} {...props}>
      <div className="flex min-w-0 items-start gap-3">
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5">
          {open ? null : (
            <span className="inline-flex h-5 items-center gap-1 rounded-full bg-t-tide px-2 text-2xs font-bold text-t-tide-fg">
              <Icon icon={Check} size={14} />
              Resolved
            </span>
          )}
          <span
            className={cn(
              "inline-flex h-5 items-center gap-1.5 rounded-full px-2 text-2xs font-bold whitespace-nowrap",
              severityStyle.pill,
            )}
          >
            <span className={cn("size-1.5 rounded-full", severityStyle.dot)} aria-hidden />
            {severityLabel[severity]}
            <span className="sr-only"> severity</span>
          </span>
          <Tag tone="well" font="sans">
            {issueKindLabel[kind]}
          </Tag>
          {toolName ? <Tag tone="term">{toolName}</Tag> : null}
        </div>
        <span className="shrink-0 pt-0.5 font-mono text-2xs text-muted">{age}</span>
      </div>

      <h3 className={cn("text-lg font-semibold", !open && "text-fg-2")}>{summary}</h3>

      <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted">
        <span className="inline-flex min-w-0 items-center gap-1.5">
          <Avatar name={agent.name} tone={agent.tone} size={24} {...(agent.src ? { src: agent.src } : {})} />
          <span className={cn("truncate font-mono text-sm font-medium", identityText[agent.tone])}>{agent.name}</span>
        </span>
        {guildName ? <span>· {guildName}</span> : null}
        {!open && resolvedBy ? <span>· resolved by {resolvedBy}</span> : null}
      </div>

      {detail ? <div className={cn("min-w-0 text-sm", open ? "text-fg-2" : "text-muted")}>{detail}</div> : null}

      {(open && onInvestigate) || onStatusChange || onOpenRun ? (
        <div className="flex flex-wrap items-center gap-2 pt-1">
          {open && onInvestigate ? (
            <Button variant="accent" size="sm" onClick={onInvestigate} disabled={pending}>
              <Icon icon={Sparkles} size={14} />
              Investigate in Studio
            </Button>
          ) : null}
          {onStatusChange ? (
            <Button
              variant="outline"
              size="sm"
              onClick={() => onStatusChange(open ? "resolved" : "open")}
              disabled={pending}
            >
              {open ? "Mark as resolved" : "Reopen"}
            </Button>
          ) : null}
          {onOpenRun ? (
            <Button variant="ghost" size="sm" onClick={onOpenRun}>
              <Icon icon={ExternalLink} size={14} />
              Open run
            </Button>
          ) : null}
        </div>
      ) : null}
    </article>
  );
}
