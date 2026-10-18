import { ChevronDown, Lock, Plus } from "lucide-react";
import { Collapsible } from "radix-ui";
import type { ReactNode } from "react";
import { cn } from "../../cn";
import { TreeRail } from "../../primitives/Divider";
import { Icon } from "../../primitives/Icon";
import { cappedCount, CountBadge } from "../identity/CountBadge";

export type GuildVisibility = "org" | "private";

export type GuildRowProps = {
  name: string;
  /** Agents in the guild. */
  agentCount: number;
  /** The guild's agent limit (`max_agents`). */
  maxAgents: number;
  /** A private guild is visible to its operators only. */
  visibility?: GuildVisibility;
  /** The guild open in the workspace; the only plum row in the sidebar. */
  selected?: boolean;
  /** Group chat messages the operator has not read; shown as a count. */
  unread?: number;
  onSelect?: () => void;
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** Shows the "Add agent" row; it is disabled once the guild is full. */
  onAddAgent?: () => void;
  /** The guild's agents, as AgentRows. */
  children?: ReactNode;
  className?: string;
};

/** A guild in the sidebar: selects the guild, and folds open onto its agents. */
export function GuildRow({
  name,
  agentCount,
  maxAgents,
  visibility,
  selected,
  unread,
  onSelect,
  open,
  defaultOpen = true,
  onOpenChange,
  onAddAgent,
  children,
  className,
}: GuildRowProps) {
  const full = agentCount >= maxAgents;
  return (
    <Collapsible.Root
      {...(open !== undefined ? { open } : { defaultOpen })}
      {...(onOpenChange ? { onOpenChange } : {})}
      className={cn("flex flex-col", className)}
    >
      <div
        data-selected={selected ? "true" : undefined}
        className={cn(
          "flex min-w-0 items-center gap-1 rounded-lg pl-1.5 transition-colors",
          selected ? "bg-plum text-on-plum" : "text-fg hover:bg-paper",
        )}
      >
        <Collapsible.Trigger
          aria-label={`Show ${name} agents`}
          className={cn(
            "group/chevron flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-md transition-colors",
            selected ? "hover:bg-on-plum-hover" : "hover:bg-well",
          )}
        >
          <Icon
            icon={ChevronDown}
            size={14}
            className="transition-transform group-data-[state=closed]/chevron:-rotate-90"
          />
        </Collapsible.Trigger>
        <button
          type="button"
          onClick={onSelect}
          aria-current={selected ? "page" : undefined}
          className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 py-2.5 pr-2.5 text-left"
        >
          <span className="min-w-0 truncate text-lg font-semibold">{name}</span>
          {visibility === "private" ? (
            <span
              title="Private to its operators"
              className={cn("flex shrink-0", selected ? "text-on-plum-muted" : "text-muted")}
            >
              <Icon icon={Lock} size={14} label="Private to its operators" />
            </span>
          ) : null}
          {unread ? (
            <CountBadge
              tone={selected ? "on-plum" : "plum"}
              className="ml-auto"
              aria-label={`${unread} unread messages`}
            >
              {cappedCount(unread)}
            </CountBadge>
          ) : null}
        </button>
      </div>
      <Collapsible.Content>
        <TreeRail className="ml-4 flex flex-col gap-0.5 pt-1 pb-2 pl-2.5">
          {children}
          {onAddAgent ? (
            <button
              type="button"
              onClick={onAddAgent}
              disabled={full}
              title={
                full
                  ? `${name} is limited to ${maxAgents} agents. Raise the limit in its settings.`
                  : undefined
              }
              className="flex w-full cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm text-muted transition-colors enabled:hover:bg-paper enabled:hover:text-fg disabled:cursor-not-allowed disabled:text-faint"
            >
              <span className="flex w-6 shrink-0 justify-center">
                <Icon icon={Plus} size={16} />
              </span>
              Add agent
            </button>
          ) : null}
        </TreeRail>
      </Collapsible.Content>
    </Collapsible.Root>
  );
}
