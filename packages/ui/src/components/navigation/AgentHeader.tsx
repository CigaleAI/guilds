import type { ComponentProps, ReactNode } from "react";
import { cn } from "../../cn";
import type { IdentityTone } from "../../identity";
import { AgentStatus, type AgentState } from "../identity/AgentStatus";
import { Avatar } from "../identity/Avatar";

export type AgentHeaderProps = Omit<ComponentProps<"header">, "children"> & {
  /** Agent handle. */
  name: string;
  tone: IdentityTone;
  src?: string;
  state: AgentState;
  /** What the agent is for (`focus`, up to 100 characters), or a control to add one. */
  focus?: ReactNode;
  /** Trailing IconButtons: expand, options (⋯), close. */
  actions?: ReactNode;
  /** Id for the name heading, so a dialog can point `aria-labelledby` at it. */
  nameId?: string;
  /** The slim phone band: smaller identity, focus truncated to one line. */
  compact?: boolean;
};

/** The top of the agent inspector: who the agent is, what it is doing, what it is for. */
export function AgentHeader({
  name,
  tone,
  src,
  state,
  focus,
  actions,
  nameId,
  compact,
  className,
  ...props
}: AgentHeaderProps) {
  return (
    <header
      className={cn(
        compact
          ? "flex shrink-0 items-center gap-3 px-4 py-2.5"
          : "flex shrink-0 items-start gap-5 px-7 pt-6 pb-5",
        className,
      )}
      {...props}
    >
      <Avatar
        name={name}
        tone={tone}
        size={compact ? 36 : 64}
        {...(src ? { src } : {})}
        aria-hidden
      />
      <div className={cn("flex min-w-0 flex-1 flex-col", compact ? "gap-0.5" : "gap-1 pt-1.5")}>
        <div className="flex min-w-0 flex-wrap items-baseline gap-x-2.5 gap-y-1">
          <h2
            id={nameId}
            className={cn(
              "min-w-0 truncate font-mono font-medium text-fg",
              compact ? "text-lg" : "text-2xl",
            )}
          >
            {name}
          </h2>
          <AgentStatus state={state} />
        </div>
        {focus ? (
          <div
            className={cn("text-fg-2", compact ? "truncate text-sm" : "text-md")}
            title={compact && typeof focus === "string" ? focus : undefined}
          >
            {focus}
          </div>
        ) : null}
      </div>
      {actions ? <div className="flex shrink-0 items-center gap-1.5">{actions}</div> : null}
    </header>
  );
}
